# GitLab CI pipeline explorer

"When does a job run?" — parse `.gitlab-ci.yml`, pick a pipeline type + gate variables, see which jobs are created, how, and why.

## Status

- `packages/core`: parser + rules evaluator + CLI (milestone 1).
- `packages/web`: UI (editor, scenario/gate panel, stage view, needs graph, rule trace, jobs × pipeline-type matrix). Runs the core in the browser (milestone 2).
  - Compare A/B tab: two scenarios side by side, only the jobs that differ (runs / when / blocking / needs …) — milestone 3.
  - The URL hash holds the config + both scenarios + tab + selected job (deflate + base64url, client-side only). "Copy link" shares the exact view.
  - Needs graph (React Flow + ELK, lazy-loaded): solid = `needs`, dashed = stage order (transitively reduced), red = need on a job excluded by rules. Click a job → its upstream/downstream chain is highlighted in both views.
- Includes + `spec:inputs` (milestone 4): GitLab merge order (included files in order, nested first, including file last), `include:rules`, variables in include paths, 150-include limit, `include:inputs`/pipeline inputs with type/options/regex validation and `$[[ inputs.x | fn ]]` interpolation. Missing files → standalone warning, evaluation continues.

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

CLI options: `--preset push|tag|mr|schedule|web|api|trigger|…`, `--branch`, `--tag`, `--mr-source/--mr-target`, `--open-mr`, `--set K=V`, `--changed a,b`, `--files a,b`, `--override job#2.changes=false`, `-i/--input K=V`, `--include-dir DIR`, `--include KEY=PATH`, `--trace`, `--gates`, `--matrix`, `--json`.

## Known limits

- `changes:`/`exists:` are assumed true unless a file list or override is given (GitLab rules: always true for tags, schedules, web/api/trigger, new branches).
- Regex: RE2 → JS translation; lookaround/backrefs rejected (as GitLab does), `U` flag ignored with a warning.
- No GitLab access by design: no proxy, no API calls. Include files are provided by the user (Includes tab: upload/paste per include, upload folder; CLI: `--include-dir`, `--include KEY=PATH`), or the full merged config is pasted (pipeline editor → "Full configuration").
- Unknown in standalone: wildcard-include order (sorted by path), project `ref` (files keyed by project + path only), `spec:include`, `$[[ component.sha ]]`.
- Not yet: `parallel:matrix`, child-pipeline subgraphs (milestone 5).
