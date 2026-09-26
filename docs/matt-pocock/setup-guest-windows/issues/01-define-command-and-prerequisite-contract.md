# Define the command and prerequisite contract

Type: grilling

## Question

What exact user-facing and preflight contract should `setup-guest-windows` expose within the map's settled scope?

Decide the supported Windows 11 Enterprise baseline; the required VM, adapter, account, host-elevation, environment, and `run-hosting` state; every flag, prompt, default, and prompt order; how the existing local administrator/development account and the distinct SMB share account are named; which checks occur before either secret is requested; and the retry promise users can rely on. Keep non-secret answers independently flaggable, both passwords masked and absent from flags, and the guest address absent because PowerShell Direct does not use it.

The answer must be specific enough to define Commander help text, preflight failures, and the prerequisite section of `setup-guest.md` without designing the internal orchestration yet.
