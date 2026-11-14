# GitLab CI pipeline explorer

"When does a job run?" — parse `.gitlab-ci.yml`, pick a pipeline type + gate variables, see which jobs are created, how, and why.

## Status

- `packages/core`: parser + rules evaluator + CLI (milestone 1).
- `packages/web`: first UI (editor, scenario/gate panel, stage view, rule trace, jobs × pipeline-type matrix). Runs the core in the browser.
- Standalone mode: `include:` entries are listed as unresolved with a visible warning (no GitLab access yet).

Run for review: `docker compose up -d --build` → <http://localhost:8090>

```
 .gitlab-ci.yml
      │  yaml/load        anchors, <<, !reference tag, spec: header split
      ▼
 normalize/        extends → !reference → default/inherit → stages → typed model
      │            (only/except kept as policies, evaluated directly)
      ▼
 evaluate/  ◄── scenario/presets (CI_PIPELINE_SOURCE, ref, MR vars…) + user vars
      │      workflow:rules → job rules / only-except → needs check
      ▼
 PipelineResult: created?, per job {included, when, blocking, needs, trace}
```

Variable precedence for `rules:if`: predefined < global YAML < workflow-rule vars < job vars < (rule vars, after match) < project/pipeline vars (`--set`). Like GitLab, `rules:if` sees raw values (no nested `$VAR` expansion); `changes`/`exists` paths are expanded. Behaviour is checked against GitLab source (`test/gitlab-parity.test.ts`).

## Dev (Docker only, nothing on the host)

```sh
./dev npm ci                     # once
./dev npm test                   # vitest
./dev npm run typecheck
./dev npm run gce -w @gce/core -- packages/core/test/fixtures/embedded.yml --matrix
```

CLI options: `--preset push|tag|mr|schedule|web|api|trigger|…`, `--branch`, `--tag`, `--mr-source/--mr-target`, `--open-mr`, `--set K=V`, `--changed a,b`, `--files a,b`, `--override job#2.changes=false`, `--trace`, `--gates`, `--matrix`, `--json`.

## Known limits

- `changes:`/`exists:` are assumed true unless a file list or override is given (GitLab rules: always true for tags, schedules, web/api/trigger, new branches).
- Regex: RE2 → JS translation; lookaround/backrefs rejected (as GitLab does), `U` flag ignored with a warning.
- Not yet: includes, `spec:inputs`, `parallel:matrix`, child-pipeline subgraphs (milestones 4–5).
