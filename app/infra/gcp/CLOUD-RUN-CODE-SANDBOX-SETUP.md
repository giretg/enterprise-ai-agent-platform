# Cloud Run kódfuttató sandbox

A szolgáltatás privát Cloud Run service, `min-instances=0`, `concurrency=1` és
Sandbox Launcher mellett. Egy HTTP kérés pontosan egy izolált életciklus:
`sandbox run → sandbox exec → sandbox delete --force`; a törlés `finally` ágban fut.

```bash
GCP_PROJECT_ID=my-project npm run code-sandbox:cloud-run-deploy
```

Az alkalmazás service accountja kapjon `roles/run.invoker` jogot a sandbox
service-re. A connectorban a kapott Cloud Run URL, `cloud_run` provider és EU
régió szerepeljen; külön token nem kell, Cloud Runon a kliens a metadata
service-ből kér audience-kötött identity tokent. Nem Cloud Run környezetből
opcionálisan `CODE_SANDBOX_SHARED_TOKEN` használható mindkét oldalon.

Vészleállítás:

- globálisan: `CODE_SANDBOX_ENABLED=false` az alkalmazáson;
- connectoronként: az agent Kapcsolatok oldalán kapcsold ki a connectort.

Keretek: `CODE_SANDBOX_MAX_CALLS_PER_SCOPE`,
`CODE_SANDBOX_MAX_EXEC_SEC_PER_SCOPE`, `CODE_SANDBOX_MAX_FILES`,
`CODE_SANDBOX_MAX_FILE_BYTES`, `CODE_SANDBOX_MAX_INPUT_BYTES`,
`CODE_SANDBOX_MAX_OUTPUT_BYTES`,
`CODE_SANDBOX_MAX_STDOUT_BYTES`, `CODE_SANDBOX_MAX_STDERR_BYTES`.
