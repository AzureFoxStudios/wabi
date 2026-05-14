use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IntentStatus {
    Pending,
    Processing,
    Succeeded,
    Failed,
    Cancelled,
    Expired,
}

impl IntentStatus {
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            IntentStatus::Succeeded
                | IntentStatus::Failed
                | IntentStatus::Cancelled
                | IntentStatus::Expired
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentIntent {
    pub id: String,
    pub provider_id: String,
    pub amount: u64,
    pub currency: String,
    pub status: IntentStatus,
    pub client_secret: Option<String>,
    pub metadata: HashMap<String, String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
    pub expires_at: Option<chrono::DateTime<chrono::Utc>>,
}

impl PaymentIntent {
    pub fn new(
        id: String,
        provider_id: String,
        amount: u64,
        currency: String,
    ) -> Self {
        let now = chrono::Utc::now();
        Self {
            id,
            provider_id,
            amount,
            currency,
            status: IntentStatus::Pending,
            client_secret: None,
            metadata: HashMap::new(),
            created_at: now,
            updated_at: now,
            expires_at: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaymentEvent {
    IntentCreated { intent_id: String },
    IntentUpdated { intent_id: String, status: IntentStatus },
    IntentCompleted { intent_id: String },
    IntentFailed { intent_id: String, reason: String },
    IntentCancelled { intent_id: String },
    WebhookReceived { event_type: String, raw: Vec<u8> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[ serde(rename_all = "camelCase")]
pub struct CreateIntentRequest {
    pub amount: u64,
    pub currency: String,
    pub country: Option<String>,
    pub metadata: Option<HashMap<String, String>>,
    pub return_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateIntentResponse {
    pub intent: PaymentIntent,
    pub client_secret: String,
    pub next_action: Option<PaymentNextAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PaymentNextAction {
    Redirect { url: String },
    QRCode { data: String },
    Wait { timeout_seconds: u64 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetIntentStatusRequest {
    pub intent_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelIntentRequest {
    pub intent_id: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyWebhookRequest {
    pub payload: Vec<u8>,
    pub signature: String,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyWebhookResponse {
    pub valid: bool,
    pub events: Vec<PaymentEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateQrRequest {
    pub intent_id: String,
    pub amount: u64,
    pub currency: String,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateQrResponse {
    pub qr_data: String,
    pub format: QrFormat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QrFormat {
    Png,
    Svg,
    Base64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratePaymentLinkRequest {
    pub intent_id: String,
    pub amount: u64,
    pub currency: String,
    pub description: Option<String>,
    pub expires_in: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratePaymentLinkResponse {
    pub url: String,
    pub expires_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CountryInfo {
    pub code: String,
    pub name: String,
    pub supported_currencies: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrencyInfo {
    pub code: String,
    pub name: String,
    pub decimal_places: u8,
    pub symbol: Option<String>,
}

#[async_trait]
pub trait PaymentProvider: Send + Sync {
    fn id(&self) -> &str;
    fn name(&self) -> &str;

    async fn supported_countries(&self) -> Vec<CountryInfo>;
    async fn supported_currencies(&self) -> Vec<CurrencyInfo>;

    async fn create_intent(
        &self,
        request: CreateIntentRequest,
    ) -> Result<CreateIntentResponse, PaymentError>;

    async fn get_intent_status(
        &self,
        request: GetIntentStatusRequest,
    ) -> Result<PaymentIntent, PaymentError>;

    async fn cancel_intent(
        &self,
        request: CancelIntentRequest,
    ) -> Result<PaymentIntent, PaymentError>;

    async fn verify_webhook(
        &self,
        request: VerifyWebhookRequest,
    ) -> Result<VerifyWebhookResponse, PaymentError>;

    async fn generate_qr(
        &self,
        request: GenerateQrRequest,
    ) -> Result<GenerateQrResponse, PaymentError>;

    async fn generate_payment_link(
        &self,
        request: GeneratePaymentLinkRequest,
    ) -> Result<GeneratePaymentLinkResponse, PaymentError>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaymentError {
    ProviderNotFound { provider_id: String },
    IntentNotFound { intent_id: String },
    IntentExpired { intent_id: String },
    InvalidAmount { amount: u64 },
    UnsupportedCurrency { currency: String },
    UnsupportedCountry { country: String },
    WebhookVerificationFailed,
    NetworkError { message: String },
    ProviderError { code: String, message: String },
    RateLimited { retry_after_seconds: u64 },
}

impl std::fmt::Display for PaymentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PaymentError::ProviderNotFound { provider_id } => {
                write!(f, "Provider not found: {}", provider_id)
            }
            PaymentError::IntentNotFound { intent_id } => {
                write!(f, "Intent not found: {}", intent_id)
            }
            PaymentError::IntentExpired { intent_id } => {
                write!(f, "Intent expired: {}", intent_id)
            }
            PaymentError::InvalidAmount { amount } => {
                write!(f, "Invalid amount: {}", amount)
            }
            PaymentError::UnsupportedCurrency { currency } => {
                write!(f, "Unsupported currency: {}", currency)
            }
            PaymentError::UnsupportedCountry { country } => {
                write!(f, "Unsupported country: {}", country)
            }
            PaymentError::WebhookVerificationFailed => {
                write!(f, "Webhook verification failed")
            }
            PaymentError::NetworkError { message } => {
                write!(f, "Network error: {}", message)
            }
            PaymentError::ProviderError { code, message } => {
                write!(f, "Provider error [{}]: {}", code, message)
            }
            PaymentError::RateLimited { retry_after_seconds } => {
                write!(f, "Rate limited, retry after {}s", retry_after_seconds)
            }
        }
    }
}

impl std::error::Error for PaymentError {}

pub mod prelude {
    pub use super::{
        CancelIntentRequest, CountryInfo, CreateIntentRequest,
        CreateIntentResponse, CurrencyInfo, GeneratePaymentLinkRequest,
        GeneratePaymentLinkResponse, GenerateQrRequest, GenerateQrResponse,
        GetIntentStatusRequest, IntentStatus, PaymentEvent, PaymentIntent,
        PaymentNextAction, PaymentProvider, PaymentError, QrFormat,
        VerifyWebhookRequest, VerifyWebhookResponse,
    };
}