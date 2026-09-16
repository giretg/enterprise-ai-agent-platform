# Cloud Run kódfuttató sandbox

A szolgáltatás privát Cloud Run service, `min-instances=0`, `concurrency=1`,
request-based billing (`--cpu-throttling`) és Sandbox Launcher mellett. Egy HTTP
kérés pontosan egy izolált életciklus: `sandbox run → sandbox exec → sandbox
delete --force`; a törlés `finally` ágban fut.

```bash
GCP_PROJECT_ID=my-project npm run code-sandbox:cloud-run-deploy
```

Az alkalmazás service accountja kapjon `roles/run.invoker` jogot a sandbox
service-re. A connectorban a kapott Cloud Run URL, `cloud_run` provider és EU
régió szerepeljen. Cloud Runon a kliens a metadata service-ből kér
audience-kötött identity tokent. Nem Cloud Run környezetben
`CODE_SANDBOX_SHARED_TOKEN` kötelező mindkét oldalon — token nélkül a sandbox
szerver 401-et ad.

Vészleállítás:

- globálisan: `CODE_SANDBOX_ENABLED=false` az alkalmazáson;
- connectoronként: az agent Kapcsolatok oldalán kapcsold ki a connectort.

Keretek: connector-config `maxCallsPerScope` / `maxExecSecPerScope`, plusz
`CODE_SANDBOX_MAX_FILES`, `CODE_SANDBOX_MAX_FILE_BYTES`,
`CODE_SANDBOX_MAX_INPUT_BYTES`, `CODE_SANDBOX_MAX_OUTPUT_BYTES`,
`CODE_SANDBOX_MAX_STDOUT_BYTES`, `CODE_SANDBOX_MAX_STDERR_BYTES`.
