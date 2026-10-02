use super::WdbAdapter;
use wabidb::projections::project_runs::{
    encode, encode_worker, ProjectRun, ProjectRunProjection, ProjectWorker,
    ProjectWorkerProjection, EVENT, WORKER_EVENT,
};
impl WdbAdapter {
    pub fn project_workers(&self, channel: &str) -> wabidb::error::Result<Vec<ProjectWorker>> {
        ProjectWorkerProjection::list(&self.engine.projection_state(), channel)
    }
    pub fn project_worker(
        &self,
        channel: &str,
        id: &str,
    ) -> wabidb::error::Result<Option<ProjectWorker>> {
        ProjectWorkerProjection::get(&self.engine.projection_state(), channel, id)
    }
    pub async fn save_project_worker(
        &self,
        worker: &ProjectWorker,
        actor: u64,
    ) -> wabidb::error::Result<()> {
        self.run(
            actor,
            "project_worker",
            worker.channel_id.clone(),
            WORKER_EVENT,
            6,
            encode_worker(worker),
            true,
            None,
        )
        .await?;
        Ok(())
    }
    pub fn project_runs(&self, channel: &str) -> wabidb::error::Result<Vec<ProjectRun>> {
        ProjectRunProjection::list(&self.engine.projection_state(), channel)
    }
    pub fn project_run(
        &self,
        channel: &str,
        id: &str,
    ) -> wabidb::error::Result<Option<ProjectRun>> {
        ProjectRunProjection::get(&self.engine.projection_state(), channel, id)
    }
    /// Caller holds project_run_write for read-modify-write and admission through tool completion.
    pub async fn save_project_run(
        &self,
        run: &ProjectRun,
        actor: u64,
    ) -> wabidb::error::Result<()> {
        self.run(
            actor,
            "project_run",
            run.channel_id.clone(),
            EVENT,
            6,
            encode(run),
            true,
            None,
        )
        .await?;
        Ok(())
    }
}
