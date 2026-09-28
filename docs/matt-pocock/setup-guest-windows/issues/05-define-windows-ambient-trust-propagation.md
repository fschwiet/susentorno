# Define Windows ambient-trust propagation

Type: grilling
Status: claimed
Blocked by: 02

## Question

How should the production Windows setup path propagate host ambient trust before any pre-isolation provisioning step accesses the network?

Decide how to promote or adapt the existing guest-tier Windows root-store logic; when host roots are enumerated and guest roots fingerprinted; which store receives missing roots; how reruns and partial imports behave; and how failures are reported. Resolve the interaction between ambient roots, the susentorno proxy CA installed by `configure-network`, and Node's `NODE_EXTRA_CA_CERTS`: the final design must not make Node trust only one set while Windows and Git trust another.

The answer must remain consistent with ADR-0028's trust-selection policy and ADR-0027's observation that the Windows implementation was deferred only until a production caller existed.
