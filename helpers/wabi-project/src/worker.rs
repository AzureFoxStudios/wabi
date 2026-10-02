use crate::connector::*;
use crate::gateway::now;
use serde_json::{Value, json};
use std::{env, time::Duration};
use tokio_util::sync::CancellationToken;
const INSTRUCTIONS: &str = include_str!("../assets/worker-instructions.txt");
pub fn active(current: &Value, claimed: &Value, now: i64) -> bool {
    current["status"] == "running"
        && current["attempt"] == claimed["attempt"]
        && current["workerId"] == claimed["workerId"]
        && !present(&current["pending"])
        && safe_int(&current["leaseUntilMicros"]).is_some_and(|t| t > now)
}
pub fn parse_action(s: &str) -> Result<Value> {
    let mut s = s.trim();
    if let Some(t) = s.strip_prefix("```") {
        s = t.strip_prefix("json").unwrap_or(t).trim_start()
    }
    if let Some(t) = s.strip_suffix("```") {
        s = t.trim_end()
    }
    let v: Value =
        serde_json::from_str(s).map_err(|_| "Model did not return a valid tool action")?;
    if !v["tool"].is_string() || !v["arguments"].is_object() {
        return Err("Model did not return a valid tool action".into());
    }
    Ok(v)
}
pub struct Worker {
    connector: Connector,
    provider: String,
    key: String,
    model: String,
    max_tokens: u64,
    reasoning: Option<String>,
    completion_path: String,
    worker_id: Option<String>,
    worker_name: String,
    clock_offset: i64,
    last_heartbeat: i64,
}
impl Worker {
    pub fn env() -> Result<Self> {
        let get = |k: &str| env::var(k).unwrap_or_default();
        let provider = get("WABI_AI_PROVIDER_URL");
        let provider = origin(if provider.is_empty() {
            "https://openrouter.ai"
        } else {
            &provider
        })?;
        let mut raw = json!({"version":1,"serverUrl":get("WABI_PROJECT_URL"),"channelId":get("WABI_PROJECT_CHANNEL_ID"),"botToken":get("WABI_BOT_TOKEN")});
        let connector = Connector::new(raw.take())?;
        let key = get("WABI_AI_API_KEY");
        let model = get("WABI_AI_MODEL");
        if key.is_empty() || model.is_empty() {
            return Err(
                "Project, bot token, provider key and an explicit model are required".into(),
            );
        }
        let tokens = get("WABI_AI_MAX_TOKENS");
        let max_tokens = if tokens.is_empty() {
            8192
        } else {
            tokens.parse().map_err(|_| "Invalid token budget")?
        };
        if !(512..=16384).contains(&max_tokens) {
            return Err("Output token budget must be between 512 and 16384".into());
        }
        let openrouter = url::Url::parse(&provider).unwrap().host_str() == Some("openrouter.ai");
        let effort = get("WABI_AI_REASONING_EFFORT");
        let reasoning = if effort.is_empty() {
            None
        } else {
            if !openrouter
                || !["none", "minimal", "low", "medium", "high"].contains(&effort.as_str())
            {
                return Err("Unsupported reasoning setting".into());
            }
            Some(effort)
        };
        let mut completion_path = get("WABI_AI_COMPLETION_PATH");
        if completion_path.is_empty() {
            completion_path = if openrouter {
                "/api/v1/chat/completions"
            } else {
                "/v1/chat/completions"
            }
            .into()
        }
        if !["/api/v1/chat/completions", "/v1/chat/completions"].contains(&completion_path.as_str())
        {
            return Err("Unsupported completion path".into());
        }
        let worker = get("WABI_WORKER_ID");
        let worker_name = get("WABI_WORKER_NAME");
        let worker_id = if worker.is_empty() {
            None
        } else {
            if worker.len() != 36
                || uuid::Uuid::parse_str(&worker).is_err()
                || worker_name.is_empty()
            {
                return Err(
                    "An enrolled worker needs a persistent UUID and a computer label".into(),
                );
            }
            Some(worker)
        };
        Ok(Self {
            connector,
            provider,
            key,
            model,
            max_tokens,
            reasoning,
            completion_path,
            worker_id,
            worker_name,
            clock_offset: 0,
            last_heartbeat: 0,
        })
    }
    fn metadata(&self, value: &Value) -> Value {
        value
            .as_str()
            .filter(|s| {
                utf16_len(s) <= 200 && !s.contains(&self.key) && !s.contains(&self.connector.token)
            })
            .map(|s| json!(s))
            .unwrap_or(Value::Null)
    }
    fn authority_now(&self) -> i64 {
        now() * 1000 + self.clock_offset
    }
    async fn request(
        &mut self,
        path: &str,
        body: Option<Value>,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let url = format!(
            "{}/api/projects/{}{}",
            self.connector.server, self.connector.channel, path
        );
        let method = if body.is_some() { "POST" } else { "GET" };
        let value = http_json(
            &self.connector.http,
            &url,
            method,
            &format!("Bot {}", self.connector.token),
            body,
            Duration::from_secs(30),
            2_000_000,
            cancel,
            false,
        )
        .await?;
        if let Some(t) = safe_int(&value["serverNowMicros"]) {
            self.clock_offset = t - now() * 1000
        }
        if path == "/runs" && self.worker_id.is_some() && value["workersEnabled"] == false {
            return Err("Worker connections addon is disabled".into());
        }
        Ok(value)
    }
    async fn action(
        &mut self,
        run: &Value,
        tool: &str,
        args: Value,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let mut b = json!({"expectedRevision":run["revision"],"attempt":run["attempt"],"operationId":uuid::Uuid::new_v4().to_string(),"tool":tool,"arguments":args});
        if let Some(id) = &self.worker_id {
            b["workerId"] = json!(id)
        }
        let id = run["runId"]
            .as_str()
            .filter(|s| valid_id(s))
            .ok_or("Invalid run ID")?;
        self.request(&format!("/runs/{id}/step"), Some(b), cancel)
            .await
    }
    async fn heartbeat(&mut self, cancel: &CancellationToken) -> Result<()> {
        if let Some(id) = self.worker_id.clone() {
            if now() - self.last_heartbeat >= 30000 {
                self.request(&format!("/workers/{id}/heartbeat"), Some(json!({})), cancel)
                    .await?;
                self.last_heartbeat = now()
            }
        }
        Ok(())
    }
    async fn current(&mut self, id: &Value, cancel: &CancellationToken) -> Result<Value> {
        Ok(self.request("/runs", None, cancel).await?["runs"]
            .as_array()
            .ok_or("Invalid runs")?
            .iter()
            .find(|r| r["runId"] == *id)
            .cloned()
            .unwrap_or(Value::Null))
    }
    pub async fn run(&mut self, once: bool, cancel: &CancellationToken) -> Result<Value> {
        let host = url::Url::parse(&self.provider)
            .unwrap()
            .host_str()
            .unwrap()
            .to_string();
        if let Some(id) = self.worker_id.clone() {
            self.request("/workers",Some(json!({"workerId":id,"name":self.worker_name,"harness":"api_worker","provider":host,"model":self.model})),cancel).await?;
            self.last_heartbeat = now()
        }
        loop {
            if cancel.is_cancelled() {
                return Ok(Value::Null);
            }
            self.heartbeat(cancel).await?;
            let snapshot = self.request("/runs", None, cancel).await?;
            let runs = snapshot["runs"].as_array().ok_or("Invalid runs")?;
            let next = runs
                .iter()
                .find(|r| {
                    r["status"] == "queued"
                        && (!present(&r["targetWorkerId"])
                            || self
                                .worker_id
                                .as_ref()
                                .is_some_and(|id| r["targetWorkerId"] == *id))
                        || self.worker_id.as_ref().is_some_and(|id| {
                            r["status"] == "running"
                                && safe_int(&r["leaseUntilMicros"])
                                    .is_some_and(|n| n <= self.authority_now())
                                && !present(&r["pending"])
                                && r["recoveryPolicy"]["automatic"] == true
                                && r["recoveryPolicy"]["backupWorkerIds"]
                                    .as_array()
                                    .is_some_and(|ids| ids.contains(&json!(id)))
                                && r["workerId"] != *id
                                && r["recoveryCount"]
                                    .as_u64()
                                    .zip(r["recoveryPolicy"]["maxRecoveries"].as_u64())
                                    .is_some_and(|(n, m)| n < m)
                        })
                })
                .cloned();
            let Some(next) = next else {
                if once {
                    return Ok(Value::Null);
                }
                delay(cancel).await;
                continue;
            };
            let run_id = next["runId"]
                .as_str()
                .filter(|s| valid_id(s))
                .ok_or("Invalid run ID")?;
            let mut body =
                json!({"expectedRevision":next["revision"],"provider":host,"model":self.model});
            if let Some(id) = &self.worker_id {
                body["workerId"] = json!(id)
            }
            let mut run = match self
                .request(&format!("/runs/{run_id}/claim"), Some(body), cancel)
                .await
            {
                Ok(r) => r,
                Err(_) => {
                    if once {
                        return Err("Run could not be claimed; another worker may be active".into());
                    }
                    delay(cancel).await;
                    continue;
                }
            };
            progress(json!({"runId":run["runId"],"status":"running"}));
            let claimed_attempt = run["attempt"].clone();
            let outcome:Result<()>=async{
    for _ in 0..=12{
     self.heartbeat(cancel).await?;let current=self.current(&run["runId"],cancel).await?;if !active(&current,&run,self.authority_now()){run=current;break}run=current;
     let steps=run["steps"].as_array().ok_or("Invalid run steps")?;let mut messages=vec![json!({"role":"system","content":INSTRUCTIONS}),json!({"role":"user","content":json!({"mode":run["mode"],"prompt":run["prompt"],"remainingToolSteps":12i64-steps.len() as i64}).to_string()})];
     for step in steps{messages.push(json!({"role":"assistant","content":json!({"tool":step["tool"],"arguments":step["arguments"]}).to_string()}));let result=step["result"].to_string();messages.push(json!({"role":"user","content":format!("Recorded tool result: {}",if utf16_len(&result)>24000{json!({"truncated":true,"excerpt":excerpt(&result,0,24000)}).to_string()}else{result})}))}
     if utf16_len(&json!(messages).to_string())>180000{return Err("Context limit reached; split this work into smaller cards".into())}
     let mut body=json!({"model":self.model,"messages":messages,"max_tokens":self.max_tokens,"temperature":0.2});if host=="openrouter.ai"{body["response_format"]=json!({"type":"json_object"})}if let Some(e)=&self.reasoning{body["reasoning"]=json!({"effort":e})}
     let answer=http_json(&self.connector.http,&format!("{}{}",self.provider,self.completion_path),"POST",&format!("Bearer {}",self.key),Some(body),Duration::from_secs(75),2_000_000,cancel,false).await?;
     progress(json!({"runId":run["runId"],"status":"model_response","model":self.metadata(&answer["model"]),"finishReason":self.metadata(&answer["choices"][0]["finish_reason"])}));
     let current=self.current(&run["runId"],cancel).await?;if !active(&current,&run,self.authority_now()){run=current;break}run=current;
     let content=answer["choices"][0]["message"]["content"].as_str().filter(|s|!s.is_empty()).ok_or("Model returned no action content; no action was taken from this response. Earlier recorded steps remain applied")?;
     let action=parse_action(content).map_err(|_|"Model returned an unsupported action; no action was taken from this response. Earlier recorded steps remain applied")?;run=self.action(&run,action["tool"].as_str().unwrap(),action["arguments"].clone(),cancel).await?;progress(json!({"runId":run["runId"],"status":run["status"],"steps":run["steps"].as_array().map_or(0,Vec::len)}));if run["status"]!="running"{break}
    }
    if run["attempt"]==claimed_attempt&&active(&run,&run,self.authority_now()){run=self.action(&run,"fail",json!({"reply":"The bounded step budget was reached. Split the remaining work into smaller cards."}),cancel).await?}Ok(())
   }.await;
            if let Err(e) = outcome {
                // Unknown step outcome is reconciled from the Authority, never retried.
                if let Ok(current) = self.current(&run["runId"], cancel).await {
                    if current["attempt"] == claimed_attempt
                        && active(&current, &run, self.authority_now())
                    {
                        if let Ok(updated)=self.action(&current,"fail",json!({"reply":format!("Worker stopped: {}. No automatic retry was made.",excerpt(&e,0,300))}),cancel).await{run=updated}
                    }
                }
                progress(json!({"runId":run["runId"],"status":run["status"]}));
                if once {
                    return Err("Worker stopped; review its Project checkpoint".into());
                }
            }
            if once {
                return Ok(run);
            }
        }
    }
}
async fn delay(cancel: &CancellationToken) {
    tokio::select! {_=cancel.cancelled()=>{},_=tokio::time::sleep(Duration::from_millis(2500))=>{}}
}
fn progress(v: Value) {
    println!("{v}")
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actions_fail_closed() {
        assert!(parse_action("do something").is_err());
        assert!(parse_action("{\"tool\":\"complete\",\"arguments\":[]}").is_err());
        assert_eq!(
            parse_action(
                "```json\n{\"tool\":\"complete\",\"arguments\":{\"reply\":\"done\"}}\n```"
            )
            .unwrap()["tool"],
            "complete"
        );
    }
    #[test]
    fn lease_attempt_worker_pending_fence() {
        let r = json!({"status":"running","attempt":2,"workerId":"worker","pending":null,"leaseUntilMicros":200});
        assert!(active(&r, &r, 100));
        for (key, value) in [
            ("status", json!("paused")),
            ("attempt", json!(3)),
            ("workerId", json!("other")),
            ("pending", json!({"tool":"create_card"})),
            ("leaseUntilMicros", json!(99)),
        ] {
            let mut current = r.clone();
            current[key] = value;
            assert!(!active(&current, &r, 100));
        }
    }
}
