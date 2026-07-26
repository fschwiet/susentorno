# Run VM end-to-end tests with QEMU under mirrored-networking WSL2

Automated Ubuntu VM tests use QEMU inside a real WSL2 distribution with mirrored networking, while Hyper-V remains the production deployment platform. This avoids requiring tests to mutate or depend on a developer's long-running Hyper-V guests and gives the harness disposable images and network fixtures, at the cost of a Windows/WSL-specific development prerequisite and an imperfect model of production networking.
