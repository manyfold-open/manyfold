---
'@manyfold/api': minor
---

A framework an edition registers (ADR-0034) can now run as a service on cloud computers. Its extension brings a pod service recipe (`podService`: how the framework is installed on the computer and the service its daemon keeps up), and the registry requires one for a service framework whose definition lists `k8s`. A recipe's install receives the repository its version was admitted from, and `rebuildShells` receives the framework's home on the host being rebuilt, so an edition's in-place version change works on a cloud computer as well as on a sandbox.
