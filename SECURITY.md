# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | Yes                |

## Reporting a Vulnerability

If you discover a security vulnerability in Potter, please report it responsibly by emailing **mmmskendzic@gmail.com**. Do not open a public GitHub issue for security-related bugs.

### What to include

- A description of the vulnerability and its potential impact
- Steps to reproduce the issue
- Any relevant logs, screenshots, or proof-of-concept code

**Please redact** any provider API tokens (Apify, Firecrawl, Browserbase, Anthropic, OpenAI), Claude conversation transcripts that contain secrets, and third-party personal data scraped during the repro unless strictly needed for the minimal reproduction. Potter's logging redacts known token values automatically; reports filed externally don't go through that layer.

### Response Timeline

- **Acknowledgement**: within 48 hours of your report
- **Critical fixes**: within 30 days of confirmed vulnerability
- **Status updates**: we will keep you informed as we investigate and resolve the issue

## Disclosure Policy

We ask that you give us reasonable time to address the vulnerability before disclosing it publicly. We are committed to working with security researchers and will credit reporters in release notes unless they prefer to remain anonymous.

## Thank You

We appreciate the work of security researchers and anyone who takes the time to report vulnerabilities responsibly. Your efforts help keep Potter and its users safe.
