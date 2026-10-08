#!/usr/bin/env bash
# Usado por cut-rc.yml y promote-prod.yml. Mismo archivo en backend y frontend.
#   release.sh cut <patch|minor|major> <ref>   corta una candidata vX.Y.Z-rc.N y mueve qa
#   release.sh promote <tag>                    pasa a PROD una candidata (o una versión ya aprobada, para rollback)
set -euo pipefail

FINAL_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+$'
RC_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+$'
CI_WORKFLOW="${CI_WORKFLOW:-ci.yml}"
REMOTE="${REMOTE:-origin}"
PUSH="${PUSH:-git push}"

fail() {
  echo "::error::$1" >&2
  exit 1
}

summary() {
  echo "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "$1" >>"$GITHUB_STEP_SUMMARY"
  fi
}

last_final() {
  git tag -l 'v*' | grep -E "$FINAL_PATTERN" | sort -V | tail -1 || true
}

bump() {
  local version="${1#v}" kind="$2" major minor patch
  IFS=. read -r major minor patch <<<"$version"
  case "$kind" in
    major) echo "v$((major + 1)).0.0" ;;
    minor) echo "v${major}.$((minor + 1)).0" ;;
    patch) echo "v${major}.${minor}.$((patch + 1))" ;;
    *) fail "Tipo de versión desconocido: $kind (patch, minor o major)" ;;
  esac
}

assert_released_line() {
  local sha="$1"
  if git merge-base --is-ancestor "$sha" "$REMOTE/master"; then
    return
  fi
  if git branch -r --contains "$sha" | grep -qE "^\s*$REMOTE/release/"; then
    return
  fi
  fail "El commit ${sha:0:12} no está en master ni en una rama release/*"
}

assert_ci_green() {
  local sha="$1" conclusion
  conclusion=$(gh run list --commit "$sha" --workflow "$CI_WORKFLOW" --limit 20 \
    --json status,conclusion -q '[.[] | select(.status == "completed")][0].conclusion // ""')
  [ "$conclusion" = "success" ] || fail "El CI del commit ${sha:0:12} no está en verde (${conclusion:-sin terminar o sin correr}). Espera a que termine o corrígelo."
}

cut() {
  local kind="$1" ref="$2" sha final open base n tag existing
  git fetch --quiet --tags --force "$REMOTE"
  git fetch --quiet "$REMOTE" "+refs/heads/*:refs/remotes/$REMOTE/*"
  sha=$(git rev-parse --verify "$REMOTE/$ref^{commit}" 2>/dev/null || git rev-parse --verify "$ref^{commit}" 2>/dev/null) ||
    fail "No existe la rama o commit $ref"
  assert_released_line "$sha"
  assert_ci_green "$sha"

  existing=$(git tag --points-at "$sha" | grep -E "$RC_PATTERN" | sort -V | tail -1 || true)
  if [ -n "$existing" ]; then
    tag="$existing"
  else
    final=$(last_final)
    open=$(git tag -l 'v*' | grep -E "$RC_PATTERN" | sed -E 's/-rc\.[0-9]+$//' | sort -Vu | tail -1 || true)
    if [ -n "$open" ] && [ "$open" != "${final:-}" ] &&
      [ "$(printf '%s\n%s\n' "${final:-v0.0.0}" "$open" | sort -V | tail -1)" = "$open" ] &&
      ! git rev-parse -q --verify "refs/tags/$open" >/dev/null; then
      base="$open"
    else
      base=$(bump "${final:-v0.0.0}" "$kind")
    fi
    n=$(git tag -l "$base-rc.*" | sed -E 's/.*-rc\.//' | sort -n | tail -1 || true)
    tag="$base-rc.$((${n:-0} + 1))"
    git tag -a "$tag" "$sha" -m "Candidata $tag para QA"
    $PUSH "$REMOTE" "refs/tags/$tag"
  fi
  $PUSH --force "$REMOTE" "$sha:refs/heads/qa"
  summary "QA queda en **$tag** (commit \`${sha:0:12}\`). Cuando se apruebe: Actions → Promover a PROD → \`$tag\`."
}

promote() {
  local tag="$1" sha final final_sha
  git fetch --quiet --tags --force "$REMOTE"
  git fetch --quiet "$REMOTE" "+refs/heads/*:refs/remotes/$REMOTE/*"
  if [[ "$tag" =~ $RC_PATTERN ]]; then
    final="${tag%-rc.*}"
  elif [[ "$tag" =~ $FINAL_PATTERN ]]; then
    final="$tag"
  else
    fail "«$tag» no es una candidata (v1.4.0-rc.2) ni una versión (v1.4.0)"
  fi
  git rev-parse -q --verify "refs/tags/$tag" >/dev/null || fail "No existe el tag $tag"
  sha=$(git rev-list -n 1 "$tag")
  assert_released_line "$sha"
  assert_ci_green "$sha"

  if git rev-parse -q --verify "refs/tags/$final" >/dev/null; then
    final_sha=$(git rev-list -n 1 "$final")
    [ "$final_sha" = "$sha" ] || fail "La versión $final ya existe en otro commit (${final_sha:0:12}): corta una candidata nueva"
  else
    git tag -a "$final" "$sha" -m "Versión $final aprobada desde $tag${GITHUB_ACTOR:+ por $GITHUB_ACTOR}"
    $PUSH "$REMOTE" "refs/tags/$final"
  fi
  $PUSH --force "$REMOTE" "$sha:refs/heads/prod"
  summary "PROD queda en **$final** (commit \`${sha:0:12}\`)."
}

case "${1:-}" in
  cut) cut "${2:-minor}" "${3:-master}" ;;
  promote) promote "${2:?Falta el tag a promover}" ;;
  *) fail "Uso: release.sh cut <patch|minor|major> <ref> | release.sh promote <tag>" ;;
esac
