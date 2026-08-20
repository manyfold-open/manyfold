# manyfold-k8s-gateway Helm chart

Deploys the in-cluster exec gateway the Manyfold API uses for its Kubernetes
runtime (`apps/k8s-gateway`): the API calls this gateway's `/exec` surface
instead of talking to your apiserver directly, so the credential you hand the
API stays a single bearer token with a pod-exec-scoped ClusterRole behind it.

## Install

```sh
helm install manyfold-gateway ./apps/k8s-gateway/helm/manyfold-k8s-gateway \
    --namespace manyfold-system --create-namespace \
    --set auth.token="$(openssl rand -hex 32)"
```

Or manage the token yourself and pass `--set auth.existingSecret=<name>`
(the Secret must carry the key `MF_K8S_GATEWAY_TOKEN`).

## Publish and wire the API

The Manyfold API reaches the gateway over HTTPS. Pick one:

- enable the bundled Ingress:
  `--set ingress.enabled=true --set ingress.host=gw.example.com`
  (plus your class/annotations/TLS), or
- publish the `ClusterIP` Service however your cluster does it (tunnel,
  LoadBalancer, same-network URL).

Then set on the API (see the self-hosting guide):

| API env | Value |
| --- | --- |
| `MF_K8S_GATEWAY_URL` | the published gateway URL |
| `MF_K8S_GATEWAY_TOKEN` | the same token the chart's Secret carries |
| `KUBECONFIG` | kubeconfig for the same cluster |

Verify before pointing the API at it: `curl -fsS https://<host>/healthz`.

## Values

See [values.yaml](./values.yaml) — image, replicas, resources, log level,
default exec timeout, service type/port, optional Ingress. The container
image is built from `apps/k8s-gateway/Dockerfile` in this repository.
