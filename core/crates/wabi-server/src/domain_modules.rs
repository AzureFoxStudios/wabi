//! Domain modules: business records and routes supplied by a crate outside
//! this server.
//!
//! A host binary passes its modules to [`AppState::new_with_modules`]. Each
//! module brings an engine part (`wabidb::domain_modules`: its event types
//! and the projection that builds its indexes) and a router, mounted at
//! `/api/domains/<id>` inside the API router, so the request timeout,
//! metrics, the pause/drain gate and the JSON body budget apply to it as to
//! every core route.
//!
//! Nothing in this server names any particular module, and the stock server
//! binary is built with none.
//!
//! A module's handlers take [`DomainContext`] as their router state,
//! identify the caller with the ordinary [`AuthUser`] extractor, read through [`DomainContext::reader`] and write
//! through [`DomainContext::write`], which rechecks the caller's credential
//! at the point of the write. Who may do what inside the module is the
//! module's own decision.

use crate::auth_extractor::AuthUser;
use crate::error::AppError;
use crate::state::AppState;
use axum::Router;
use std::sync::Arc;
use wabidb::domain_modules::{DomainEvent, DomainReader};
use wabidb::sequencer::types::CommandOutcome;

/// Builds a module's routes. Paths are relative to `/api/domains/<id>`.
pub type DomainRoutes = Arc<dyn Fn(DomainContext) -> Router<Arc<AppState>> + Send + Sync>;

/// A domain module as registered with the server.
#[derive(Clone)]
pub struct DomainModule {
    pub engine: wabidb::domain_modules::DomainModule,
    pub routes: DomainRoutes,
}

/// What a module's handlers are given: its own records, and the server state
/// for the ordinary extractors.
#[derive(Clone)]
pub struct DomainContext {
    id: &'static str,
    state: Arc<AppState>,
}

impl DomainContext {
    pub(crate) fn new(id: &'static str, state: Arc<AppState>) -> Self {
        Self { id, state }
    }

    pub fn id(&self) -> &'static str {
        self.id
    }

    /// Read access to the module's indexes.
    pub fn reader(&self) -> Result<DomainReader, AppError> {
        Ok(self.state.wdb.engine().domain_reader(self.id)?)
    }

    /// Write the events of one command on behalf of `user` and wait until
    /// they are durable and applied. The caller's credential is rechecked
    /// here and held valid until the write has finished, so a token revoked
    /// while the request was being read cannot write.
    ///
    /// `idempotency_key` de-duplicates a retried command only while this
    /// server process lives.
    pub async fn write(
        &self,
        user: &AuthUser,
        command_name: &str,
        idempotency_key: Option<String>,
        events: Vec<DomainEvent>,
    ) -> Result<CommandOutcome, AppError> {
        let _admitted = user.admit_current(&self.state).await?;
        self.state
            .wdb
            .engine()
            .write_domain_events(self.id, user.user_id as u64, command_name, idempotency_key, events)
            .await
            .map_err(|error| match error {
                // An event the engine will not take from this module (a
                // foreign event type, a stream outside its names) is the
                // request's fault, not the server's.
                wabidb::error::WabiError::Validation { reason, .. } => AppError::BadRequest(reason),
                other => AppError::Wdb(other),
            })
    }
}

/// Lets a module use its [`DomainContext`] as router state and still take
/// the server's extractors ([`AuthUser`] and the like) in its handlers.
impl axum::extract::FromRef<DomainContext> for Arc<AppState> {
    fn from_ref(context: &DomainContext) -> Self {
        Arc::clone(&context.state)
    }
}

/// Mount every registered module under `/domains/<id>`.
pub(crate) fn mount(router: Router<Arc<AppState>>, state: &Arc<AppState>) -> Router<Arc<AppState>> {
    state.domain_modules.iter().fold(router, |router, module| {
        let context = DomainContext::new(module.engine.id, Arc::clone(state));
        router.nest(&format!("/domains/{}", module.engine.id), (module.routes)(context))
    })
}
