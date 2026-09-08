---
---

Internal refactor with no behaviour change: the OpenAI-compatible gateway chat
transport and its runner-held turn-rpc variant move out of `OpenclawAdapter`
into a new `GatewayHttpChatAdapter` base, which NarraNexus now extends
directly. Every transport still routes exactly as before — this only gives
NarraNexus ownership of the transport it actually uses, so openclaw's own
gateway-http path can be retired separately (ADR-0027).
