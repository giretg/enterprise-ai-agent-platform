# Dedicated dispatch-cycle Cloud Run service

This deploys the existing `POST /api/v1/internal/dispatch-cycle` HTTP contract as a separate Cloud Run service. The domain implementation (`runDispatchCycle`) is unchanged; only the runtime target and resource profile are separated from the Firebase App Hosting UI.

## Why

A dispatch cycle can run stale reclaim, scheduled-task materialization, monitor sweeps, channel-turn processing, retention cleanup, workspace purge and ready-ticket dispatch. Running that workload on the UI service couples worker CPU/memory spikes to interactive latency and OOM risk.

## Deploy the worker

```bash
cd app
cp infra/gcp/dispatch-cycle-service.env.example infra/gcp/dispatch-cycle-service.env
# Fill project, region, secret names and optional runtime env/secrets.
bash infra/gcp/deploy-dispatch-cycle-service.sh
```

The script deploys from `app/`, uses `--no-allow-unauthenticated`, and gives the worker its own CPU, memory, scaling, timeout and concurrency settings.

Grant the Cloud Scheduler caller permission to invoke the service:

```bash
gcloud run services add-iam-policy-binding platform-dispatch-cycle \
  --project="$GCP_PROJECT_ID" \
  --region="$GCP_REGION" \
  --member="serviceAccount:$OIDC_SERVICE_ACCOUNT_EMAIL" \
  --role="roles/run.invoker"
```

## Point Scheduler to the worker

```bash
cp infra/gcp/dispatch-cycle-scheduler.env.example infra/gcp/dispatch-cycle-scheduler.env
# Set DISPATCH_CYCLE_TARGET_URL to the worker URL and configure OIDC_SERVICE_ACCOUNT_EMAIL.
bash infra/gcp/deploy-dispatch-cycle-scheduler.sh
```

The Scheduler still sends `x-dispatcher-token` and calls the same path. OIDC authenticates the caller at Cloud Run; the shared token remains the application-level control.

## Smoke test

```bash
gcloud scheduler jobs run dispatch-cycle-sweep \
  --project="$GCP_PROJECT_ID" \
  --location="$GCP_REGION"

gcloud scheduler jobs describe dispatch-cycle-sweep \
  --project="$GCP_PROJECT_ID" \
  --location="$GCP_REGION" \
  --format="yaml(httpTarget.uri,status)"
```

Verify:

1. the target URI is the dedicated worker URL;
2. the run returns 2xx;
3. the Control Plane worker panel records the latest cycle;
4. ready-ticket, monitor and channel-turn safety-net behavior remains unchanged;
5. UI latency/error metrics no longer include Scheduler-triggered cycle traffic.

## Rollback

Set `DISPATCH_CYCLE_TARGET_URL` in `dispatch-cycle-scheduler.env` back to the Firebase App Hosting UI URL and rerun `deploy-dispatch-cycle-scheduler.sh`. No database migration, API change or application feature flag is involved.

## Not the legacy wiki-dispatcher

This service is a stateless HTTP target invoked by Cloud Scheduler. It does not restore the old long-running LISTEN/NOTIFY `wiki-dispatcher` process and does not require a permanently open Neon connection.
