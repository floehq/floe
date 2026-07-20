# Security Policy

Floe takes security seriously. We appreciate your efforts to responsibly disclose any vulnerabilities you find.

## Supported Versions

Only the latest release receives security patches. Please ensure you are running the most recent version before reporting a vulnerability.

## Reporting a Vulnerability

**Do not open a public GitHub Issue for security vulnerabilities.**

Instead, please report vulnerabilities through one of the following channels:

- **GitHub Issues**: Create an issue using the **security** label for non-sensitive reports.
- **Email**: Contact the project maintainer directly via GitHub Issues for sensitive disclosures that should remain private.

## What to Include

Please include as much of the following as possible:

- Affected endpoint or component
- Steps to reproduce the issue
- Expected vs. actual behavior
- Potential impact assessment
- Logs, request samples, or screenshots if relevant

## Response Timeline

- **Acknowledgment**: Within 72 hours of your report.
- **Initial assessment**: Within 7 days, with a status update.
- **Resolution**: Dependent on severity and complexity, but we aim to resolve critical issues promptly.

## Disclosure Policy

- We will confirm receipt of your report and provide an estimated timeline for a fix.
- We will notify you when the vulnerability has been fixed and coordinate public disclosure if appropriate.
- We ask that you do not publicly disclose the vulnerability until a fix is available.
- Credit will be given to reporters in release notes unless anonymity is preferred.

## Security-Sensitive Surfaces

For reference, the current security-sensitive surfaces include:

- Upload creation and chunk ingestion
- Upload finalization and file metadata minting
- File reads and stream access
- Metrics and operational endpoints

For detailed information on Floe's security controls and deployment hardening, see [docs/SECURITY.md](docs/SECURITY.md).
