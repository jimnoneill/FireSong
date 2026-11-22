use app_api::CommandError;
use axum::{
    extract::{Path as AxumPath, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::Value;

use crate::state::AppState;

pub(crate) struct ApiError(CommandError);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status =
            StatusCode::from_u16(self.0.status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        (status, self.0.to_string()).into_response()
    }
}

/// Commands do their library, file and analyzer work synchronously, and some
/// of it takes seconds (summing a song cache on a network share took 19 s
/// cold). They run on the blocking pool, so that work never holds up the
/// async runtime that carries the TV's and the phones' sockets.
async fn dispatch(state: &AppState, name: String, payload: Value) -> Response {
    let commands = state.commands.clone();
    let runtime = tokio::runtime::Handle::current();
    let ran = tokio::task::spawn_blocking(move || {
        runtime.block_on(app_api::dispatch(commands, &name, payload))
    })
    .await;
    match ran {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(error)) => ApiError(error).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("command failed: {error}"),
        )
            .into_response(),
    }
}

pub(crate) async fn handle_cmd(
    State(state): State<AppState>,
    AxumPath(name): AxumPath<String>,
    body: Option<Json<Value>>,
) -> Response {
    let payload = body.map(|Json(value)| value).unwrap_or(Value::Null);
    dispatch(&state, name, payload).await
}

/// Same dispatch as [`handle_cmd`], restricted to the phone door's commands
/// ([`crate::firesong::phone_commands`]).
/// Rejecting unknown names here (rather than only hiding them in the phone UI)
/// keeps the LAN surface honest when someone pokes the endpoint by hand.
pub(crate) async fn handle_remote_cmd(
    State(state): State<AppState>,
    AxumPath(name): AxumPath<String>,
    body: Option<Json<Value>>,
) -> Response {
    if !crate::firesong::phone_commands(&state).contains(&name.as_str()) {
        return (
            StatusCode::FORBIDDEN,
            "command is not available to remote clients",
        )
            .into_response();
    }

    let payload = body.map(|Json(value)| value).unwrap_or(Value::Null);
    dispatch(&state, name, payload).await
}
