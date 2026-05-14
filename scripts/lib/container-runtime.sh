#!/usr/bin/env bash

if [[ -n "${WABI_CONTAINER_RUNTIME_LIB_LOADED:-}" ]]; then
  return 0
fi
WABI_CONTAINER_RUNTIME_LIB_LOADED=1

COMPOSE_CMD=()
COMPOSE_DISPLAY=""
COMPOSE_RUNTIME_KIND=""
CONTAINER_ENGINE=""
CONTAINER_RUNTIME_LABEL=""

_set_compose_runtime() {
  local engine="$1"
  local label="$2"
  local kind="$3"
  shift 3
  COMPOSE_CMD=("$@")
  COMPOSE_DISPLAY="${COMPOSE_CMD[*]}"
  COMPOSE_RUNTIME_KIND="$kind"
  CONTAINER_ENGINE="$engine"
  CONTAINER_RUNTIME_LABEL="$label"
}

_try_compose_runtime() {
  local candidate="$1"
  case "$candidate" in
    docker)
      if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
        _set_compose_runtime "docker" "Docker" "docker-compose-plugin" docker compose
        return 0
      fi
      if command -v docker-compose >/dev/null 2>&1; then
        _set_compose_runtime "docker" "Docker" "docker-compose-standalone" docker-compose
        return 0
      fi
      ;;
    podman)
      if command -v podman >/dev/null 2>&1 && podman compose version >/dev/null 2>&1; then
        _set_compose_runtime "podman" "Podman" "podman-compose-plugin" podman compose
        return 0
      fi
      if command -v podman-compose >/dev/null 2>&1; then
        _set_compose_runtime "podman" "Podman" "podman-compose-standalone" podman-compose
        return 0
      fi
      ;;
  esac
  return 1
}

detect_compose_runtime() {
  local requested="${1:-${WABI_CONTAINER_RUNTIME:-auto}}"
  requested="$(printf '%s' "$requested" | tr '[:upper:]' '[:lower:]')"

  COMPOSE_CMD=()
  COMPOSE_DISPLAY=""
  COMPOSE_RUNTIME_KIND=""
  CONTAINER_ENGINE=""
  CONTAINER_RUNTIME_LABEL=""

  case "$requested" in
    ""|auto)
      _try_compose_runtime docker || _try_compose_runtime podman || true
      ;;
    docker|podman)
      _try_compose_runtime "$requested" || true
      ;;
    *)
      echo "Invalid WABI_CONTAINER_RUNTIME: $requested (expected auto|docker|podman)" >&2
      return 1
      ;;
  esac

  if [[ ${#COMPOSE_CMD[@]} -gt 0 ]]; then
    return 0
  fi

  if [[ "$requested" == "docker" ]]; then
    echo "Docker Compose was requested, but neither 'docker compose' nor 'docker-compose' is available." >&2
  elif [[ "$requested" == "podman" ]]; then
    echo "Podman Compose was requested, but neither 'podman compose' nor 'podman-compose' is available." >&2
  else
    echo "No supported container compose runtime found. Install Docker Compose or Podman Compose, or set WABI_CONTAINER_RUNTIME=docker|podman." >&2
  fi
  return 1
}

get_container_engine_version() {
  if [[ -z "${CONTAINER_ENGINE:-}" ]]; then
    echo "?"
    return 0
  fi

  local version
  version="$("$CONTAINER_ENGINE" --version 2>/dev/null | head -1 || true)"
  if [[ -z "$version" ]]; then
    echo "?"
  else
    echo "$version"
  fi
}

get_compose_version() {
  if [[ ${#COMPOSE_CMD[@]} -eq 0 ]]; then
    echo "?"
    return 0
  fi

  local version
  version="$("${COMPOSE_CMD[@]}" version --short 2>/dev/null || true)"
  if [[ -n "$version" ]]; then
    echo "$version"
    return 0
  fi

  version="$("${COMPOSE_CMD[@]}" version 2>/dev/null | head -1 || true)"
  if [[ -z "$version" ]]; then
    echo "?"
  else
    echo "$version"
  fi
}
