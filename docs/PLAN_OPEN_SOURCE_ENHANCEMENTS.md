# Plan: Open-Source Capability Enhancements for Riverside OS

**Status:** Proposed architecture and product plan

**Implementation status:** Plan documented; the first Register camera-scanning extension and always-visible Parked Sales access are implemented locally and awaiting normal runtime/device certification

**Decision authority:** Each project, dependency, service, migration, deployment, and production rollout requires separate approval

**Primary objective:** Add high-value capabilities to Riverside OS without replacing its authoritative financial, inventory, identity, customer, or fulfillment systems

---

## 1. Executive summary

Riverside OS can gain meaningful capabilities from selected open-source projects, but the safest strategy is to add narrow capability services around the existing product rather than introduce another ERP, POS, CRM, commerce, search, or reporting platform.

The highest-value opportunities are:

1. **Professional quote and agreement documents** using Gotenberg, with Documenso considered later for signatures.
2. **Camera-based barcode workflows** by extending Riverside OS's existing `html5-qrcode` CameraScanner for Register, receiving, cycle counts, inventory lookup, and future line-busting.
3. **Resilient media capture and processing** using Uppy, tusd, and imgproxy for catalog, wedding, alteration, and damage evidence.
4. **Controlled feature rollout and training mode** using OpenFeature and flagd.
5. **Searchable distributed tracing** using the existing OpenTelemetry output with an OpenTelemetry Collector and Jaeger.
6. **Software supply-chain and application security checks** using Trivy, OSV-Scanner, and OWASP ZAP.
7. **Encrypted off-site backup replication** using Kopia around verified PostgreSQL backup artifacts.
8. **Database-level audit evidence** using pgAudit for narrowly selected administrative activity.
9. **Read-only synchronized views** using ElectricSQL for future customer displays, handheld clients, or portals.
10. **Recommendation and relevance ranking** using Metarank only after Riverside OS has sufficient privacy-safe behavioral signals.

The recommended first delivery wave is deliberately small: security reporting, staging trace visibility, a Gotenberg quote-PDF prototype, and extension of the existing permission-gated camera-scanning workflow. The Register camera entry point now reuses that existing scanner and authoritative product-scan path; no second barcode library is needed. Documenso, ElectricSQL, and Metarank should remain later-phase options until the native Riverside OS lifecycle they depend on is complete and stable.

---

## 2. Current Riverside OS baseline

Riverside OS already contains substantial platform capability:

- PostgreSQL is the authoritative transactional database.
- Rust/Axum services enforce domain rules, permissions, and financial invariants.
- React/Vite and Tauri provide staff and native workstation experiences.
- Redis supports caching, locking, session storage, and background jobs.
- Meilisearch supports fast search while PostgreSQL remains authoritative.
- Cube-powered Insights covers governed reporting and analytics.
- pgvector supports local intelligence use cases.
- Prometheus-compatible metrics and OpenTelemetry tracing already provide observability foundations.
- Transactional outbox patterns protect integrations from external service downtime.
- Existing deployment and recovery tooling targets the Main Hub production model.

The [POS Register full audit](reviews/POS_REGISTER_FULL_AUDIT_2026-08-04.md) identifies several competitive capability gaps that are particularly suitable for bounded open-source enhancement:

- a formal quote lifecycle;
- customer or wedding-party portal experiences;
- a customer-facing display;
- handheld selling and operational workflows;
- configurable register actions;
- an explicit training mode.

This plan addresses those gaps without creating a second source of business truth.

---

## 3. Product posture

### 3.1 Core rule

**Riverside OS remains the system of record.** Open-source projects may render, transmit, synchronize, scan, analyze, observe, or protect Riverside OS data, but they must not independently decide or mutate authoritative business state.

### 3.2 Authoritative boundaries

The following always remain authoritative in Riverside OS:

- prices, promotions, discounts, tax, and exemptions;
- Transactions, tenders, allocations, deposits, returns, refunds, and revenue recognition;
- stock, reservations, receiving, transfers, adjustments, and fulfillment status;
- customer identity, consent, loyalty, wedding-party membership, and staff access;
- staff roles, permissions, Manager Access, and audit identity;
- appointment ownership and operational capacity;
- quote status, acceptance status, and any conversion from a quote to a Transaction;
- provider connection state, external identifiers, replay state, and integration audit history.

### 3.3 Integration rule

Every new service must be integrated through an existing or purpose-built Riverside OS adapter that provides:

- server-side authentication and authorization;
- server-side validation of all client and provider input;
- idempotency for retries and webhooks;
- explicit timeouts and failure states;
- structured logging, metrics, and tracing;
- auditable provider identifiers and timestamps;
- safe retry or dead-letter behavior where applicable;
- a documented disable, rollback, and data-export path.

No sidecar or external project may write directly to Riverside OS database tables.

---

## 4. Goals and non-goals

### Goals

- Close high-value product gaps with smaller, proven building blocks.
- Improve staff workflows without weakening existing domain rules.
- Reuse the current Rust, React, PostgreSQL, Redis, and OpenTelemetry architecture.
- Favor local or self-hosted operation where it improves privacy and reliability.
- Make every new capability observable, reversible, supportable, and permission-aware.
- Establish clear legal, security, operational, and production-readiness gates.

### Non-goals

- Replacing Riverside OS with another POS, ERP, CRM, commerce, or inventory suite.
- Maintaining two authoritative representations of financial or inventory state.
- Allowing third-party workflow engines to bypass Riverside OS permissions or audit paths.
- Adding dependencies solely because they are popular or open source.
- Deploying experimental services to the Main Hub without resource measurements and recovery procedures.
- Treating an open-source license as automatic approval for production, redistribution, embedding, or hosted use.
- Implementing all projects in this document.

---

## 5. Evaluation criteria

Every candidate should be evaluated against the same criteria:

| Criterion | Required question |
| --- | --- |
| Business value | Does this solve a documented staff or customer problem? |
| Architectural fit | Can it extend current services without creating a parallel system of record? |
| Financial safety | Can Riverside OS retain final authority over money, tax, tender, and accounting? |
| Permission safety | Are all actions checked by Riverside OS server-side permissions? |
| Operational fit | Can it run within known Main Hub or remote-infrastructure resource limits? |
| Failure isolation | Does Riverside OS remain safe and usable when the project is unavailable? |
| Maintainability | Is the integration smaller than building and operating an equivalent feature internally? |
| License fit | Are use, modification, distribution, networking, and branding obligations understood? |
| Security posture | Are releases, images, dependencies, vulnerabilities, and secrets manageable? |
| Exit path | Can Riverside OS disable or replace it without losing authoritative data? |

---

## 6. Recommended portfolio

| Priority | Project or bundle | Riverside OS capability | License posture | Recommended disposition |
| --- | --- | --- | --- | --- |
| P0 | Trivy + OSV-Scanner | Dependency, image, secret, license, and SBOM visibility | Permissive | Begin in reporting-only CI |
| P0 | OpenTelemetry Collector + Jaeger | Searchable end-to-end traces | Apache-2.0 | Pilot in development/staging |
| P1 | Gotenberg | Versioned quote and operational PDFs | MIT | Prototype first |
| P1 | Existing CameraScanner + `html5-qrcode` | Camera barcode scanning | Apache-2.0 | Extend the established component; do not add a duplicate scanner library |
| P1 | OpenFeature + flagd | Feature flags, kill switches, staged rollout, training mode controls | Apache-2.0 | Establish before broader pilots |
| P2 | Documenso | Electronic signatures and agreement audit trails | AGPL/open-core considerations | Add only after quote lifecycle is native and stable |
| P2 | Uppy + tusd + imgproxy | Resumable uploads and efficient media delivery | MIT / Apache-2.0 | Add as one governed media pipeline |
| P2 | Kopia | Encrypted deduplicated off-site backup copies | Apache-2.0 | Pilot around verified backup artifacts |
| P2 | pgAudit | Selected database audit evidence | PostgreSQL License | Use narrowly after volume testing |
| P3 | ElectricSQL | Permission-scoped read-model synchronization | Apache-2.0 | Use only for new read-heavy clients |
| P3 | Metarank | Recommendation and relevance ranking | Apache-2.0 | Defer until signal and privacy requirements are met |
| Conditional | Easy!Appointments | External appointment-booking channel | GPL-3.0 | Consider only if current booking expansion is insufficient |
| Conditional | Valkey | Vendor-neutral Redis-compatible infrastructure | BSD-3-Clause | Evaluate during a future cache/queue infrastructure review |

Priorities describe evaluation order, not authorization to install or deploy.

---

## 7. Capability plan: Quotes, documents, and signatures

### 7.1 Projects

- [Gotenberg](https://github.com/gotenberg/gotenberg) provides a containerized API for converting HTML, Markdown, URLs, and office documents into PDFs, with support for formats such as PDF/A.
- [Documenso](https://github.com/documenso/documenso) provides self-hostable document signing, APIs, webhooks, and embedding options. Its edition and license obligations require review before adoption.

### 7.2 Riverside OS opportunity

Build a native quote lifecycle for wedding, retail, alteration, and special-order use cases while using Gotenberg only as the document renderer. Add Documenso later only if electronic acceptance and signature audit trails are a validated business requirement.

Potential capabilities include:

- professionally formatted quote PDFs;
- immutable document versions as price, tax, selections, or expiration changes;
- customer and wedding-member review copies;
- alteration agreements and acknowledgment documents;
- consistent printable and email-ready documents;
- optional electronic signatures with provider audit evidence;
- clear quote expiration, supersession, acceptance, and conversion history.

### 7.3 Required architecture

```text
Staff edits quote in Riverside OS
        |
        v
Riverside OS validates prices, tax, permissions, and customer context
        |
        v
Riverside OS stores an immutable quote version
        |
        +--> Gotenberg renders approved HTML into PDF
        |        |
        |        v
        |    PDF stored using Riverside OS document policy
        |
        +--> Optional later: Documenso receives a signing copy
                 |
                 v
             Webhook returns signature status and evidence
                 |
                 v
             Riverside OS validates and records provider state
```

Gotenberg must never calculate totals. The rendered document must use a server-created snapshot whose amounts and labels have already been validated by Riverside OS.

Documenso acceptance must not automatically create a Transaction, capture a payment, reserve stock, decrement inventory, or create a Fulfillment Order. Any conversion must return to a permission-checked Riverside OS workflow with explicit staff confirmation.

### 7.4 Indicative Riverside OS records

The exact schema requires a separate design task. A future implementation will likely need concepts equivalent to:

- a quote identity and lifecycle status;
- immutable quote versions;
- document hash, storage identity, template version, and generation timestamp;
- expiration and supersession metadata;
- external signature request, recipient, and provider-event identifiers;
- conversion linkage to the resulting financial Transaction and any Fulfillment Order;
- staff identity and reason for audit-sensitive changes.

These are domain requirements, not approved table or API names.

### 7.5 Failure behavior

- If Gotenberg is unavailable, the quote remains saved and visibly marked as awaiting document generation.
- Generation retries must be idempotent and must not create conflicting active versions.
- If Documenso is unavailable, unsigned quote work remains usable in Riverside OS.
- Invalid, duplicated, late, or out-of-order webhooks must be ignored or quarantined safely.
- A signature provider status may enrich Riverside OS state but cannot override a newer Riverside OS version.

### 7.6 Acceptance criteria

- PDF totals exactly match the authoritative quote snapshot at cent precision.
- Re-generating a version produces the same business content and a traceable template/render version.
- Superseded versions remain available to authorized staff but cannot be accepted as current.
- Signature events are idempotent, timestamped, provider-referenced, and auditable.
- Signed documents and audit evidence are exportable without continued provider availability.
- Accessibility, print layout, email delivery, and retention policies are tested.
- License and legal review is complete before any Documenso production use.

---

## 8. Capability plan: Camera barcode and handheld operations

### 8.1 Existing project and decision

Riverside OS already ships [`html5-qrcode`](https://github.com/mebjas/html5-qrcode) 2.3.8 under Apache-2.0 and wraps it in the reusable `CameraScanner` component. Receiving and Physical Inventory already use this component, and Register product search now exposes it through the same authoritative scan handler used by hardware scanners.

ZXing Browser was evaluated but is not being added. Introducing it would duplicate an established capability, increase browser-camera test surface, and create two scanner lifecycles to maintain.

### 8.2 Riverside OS opportunity

Add camera-based scanning to existing responsive screens without requiring a separate native scanner integration for every mobile device.

Recommended workflow order:

1. product lookup;
2. receiving verification;
3. cycle count entry;
4. inventory transfer preparation;
5. order or pickup verification;
6. line-busting cart preparation, only after the read and inventory workflows are proven.

### 8.3 Required boundaries

- A decoded barcode is untrusted input.
- The Riverside OS API must resolve the scanned code to current authoritative catalog and inventory data.
- Receiving, count, transfer, pickup, and cart actions must use existing domain logic and permissions.
- A scan must never directly adjust inventory or confirm fulfillment.
- Ambiguous, duplicate, inactive, or unknown codes require a clear review state.
- Offline behavior must be designed per workflow; no general offline-write permission is implied.

### 8.4 User-experience requirements

- explicit camera permission explanation;
- visible active-scanning state and stop control;
- torch and camera selection where supported;
- manual-entry fallback;
- duplicate-scan feedback without arbitrary delays;
- large touch targets and accessible status announcements;
- clear location, register, staff, and task context;
- no silent acceptance after an uncertain match.

### 8.5 Pilot recommendation

Begin with handheld catalog lookup or receiving verification. Do not begin with payment, price override, inventory adjustment, or fulfillment completion.

### 8.6 Acceptance criteria

- Supported barcode formats and expected devices are documented.
- Scan accuracy and time-to-result are measured in store lighting conditions.
- All mutations require an authenticated, permission-checked Riverside OS request.
- Duplicate scans are deterministic and auditable.
- Mobile Safari, mobile Chrome, and the supported workstation camera path are tested.
- Targeted Playwright coverage includes permission denial, unknown barcode, ambiguous match, and retry behavior.

---

## 9. Capability plan: Resilient media capture and delivery

### 9.1 Projects

- [Uppy](https://github.com/transloadit/uppy) provides a modular, accessible browser uploader with camera and resumable-upload support.
- [tusd](https://github.com/tus/tusd) is a reference server for the tus resumable-upload protocol.
- [imgproxy](https://github.com/imgproxy/imgproxy) securely transforms, resizes, and optimizes source images for delivery.

### 9.2 Riverside OS opportunity

Create one governed media pipeline for:

- product and variation images;
- wedding inspiration and fitting references;
- alteration before/after evidence;
- return or damage evidence;
- receiving discrepancies;
- customer-approved documents and attachments.

This would replace fragile one-request uploads with resumable mobile capture and consistent display derivatives.

### 9.3 Required architecture

- Riverside OS issues short-lived upload authorization for a specific staff member, customer context, purpose, size, and media type.
- Uploads land in quarantine, not immediately in a public or staff-visible collection.
- Server-side validation confirms actual content type, size, dimensions, and allowed purpose.
- Metadata is sanitized, including removal of location-bearing EXIF data unless explicitly needed and approved.
- Malware scanning is completed before the asset becomes active.
- Riverside OS records the authoritative association, access policy, retention policy, and audit identity.
- imgproxy uses signed source and transformation URLs; original object locations remain private.

### 9.4 Failure behavior

- Interrupted uploads can resume without creating multiple active assets.
- Failed validation leaves the asset quarantined with a clear staff-visible outcome.
- Failure of imgproxy must not delete or corrupt the original.
- Failure of the upload service must not block unrelated customer, order, or POS work.

### 9.5 Acceptance criteria

- Large uploads resume reliably across short mobile network interruptions.
- Unauthorized users cannot enumerate, transform, or retrieve private source objects.
- Content-type spoofing, oversized files, malformed images, and decompression bombs are rejected.
- Derivatives are deterministic and do not become a new source of truth.
- Retention and deletion flows cover originals, derivatives, quarantine, and backups.
- Staff manuals explain capture, review, retry, and privacy behavior before release.

---

## 10. Capability plan: Feature flags, pilots, and training mode

### 10.1 Projects

- [OpenFeature](https://openfeature.dev/docs/reference/sdks/) provides a vendor-neutral feature-flag API with Rust, Web, and React SDKs.
- [flagd](https://github.com/open-feature/flagd) provides an OpenFeature-compatible flag evaluation daemon with targeting and percentage rollout support.

### 10.2 Riverside OS opportunity

Use a governed flag system to support:

- per-register or per-location pilots;
- staff-group previews;
- rapid kill switches for non-essential features;
- staged customer-display or handheld rollout;
- controlled transition between legacy and replacement integration paths;
- explicit training-mode availability.

### 10.3 Non-negotiable rules

- Flags do not grant permission and cannot bypass RBAC.
- Flags do not weaken price, tax, inventory, financial, return, or fulfillment invariants.
- Financially sensitive defaults must fail closed.
- Server-side evaluation controls server behavior; client flags affect presentation only.
- Flag changes require identified staff or administrator provenance and audit history.
- Production flags need owners, descriptions, expiry/review dates, and safe defaults.
- Training mode must use isolated or explicitly marked non-production business state. A visual banner alone is insufficient.

### 10.4 Recommended implementation sequence

1. Define flag taxonomy, ownership, audit, defaults, and expiry policy.
2. Add one non-critical server/client flag end to end.
3. Prove behavior with flagd unavailable.
4. Add per-register targeting only after identity and context are validated server-side.
5. Design training data isolation as a separate feature project.

### 10.5 Acceptance criteria

- The application starts safely when flagd is unreachable.
- Financial, authorization, and audit behavior does not depend on client-supplied targeting fields.
- Default values are explicit and tested.
- Flag changes appear in operational audit evidence.
- Stale flags are identified and removed on a defined cadence.

---

## 11. Capability plan: Searchable tracing and diagnostics

### 11.1 Projects

- [OpenTelemetry Collector Contrib](https://github.com/open-telemetry/opentelemetry-collector-contrib) provides receivers, processors, and exporters for telemetry pipelines.
- [Jaeger](https://github.com/jaegertracing/jaeger) provides distributed trace storage and investigation, including OTLP ingestion and a trace-search interface.

### 11.2 Riverside OS opportunity

Riverside OS already emits OpenTelemetry data. A Collector and Jaeger pilot can turn that output into searchable request, job, integration, database, and provider latency traces without changing business behavior.

Priority diagnostic journeys include:

- POS checkout and tender orchestration;
- Helcim or other provider interactions;
- transactional outbox dispatch and replay;
- Counterpoint synchronization;
- customer search and catalog lookup;
- background jobs;
- document rendering, signing, and media processing introduced by this plan.

### 11.3 Privacy and resource rules

- Never include Access PINs, tokens, secrets, card data, message bodies, document bodies, or raw customer data in spans.
- Use stable operation identifiers rather than names, email addresses, or phone numbers.
- Apply attribute allowlists and payload-size limits at the Collector.
- Define sampling separately for routine traffic, errors, and audit-sensitive flows.
- Establish retention and role-controlled access.
- Run the first pilot in development or staging, or on an approved remote operations host—not as an unmeasured production Main Hub burden.

### 11.4 Acceptance criteria

- A trace can follow one permitted test request through the API and relevant background job or provider adapter.
- Sensitive-data tests show prohibited attributes are absent.
- Collector or Jaeger downtime does not break Riverside OS requests.
- CPU, memory, storage, network, sampling, and retention costs are measured.
- Production enablement has alerting, backup/retention decisions, and a disable procedure.

---

## 12. Capability plan: Supply-chain and application security

### 12.1 Projects

- [Trivy](https://github.com/aquasecurity/trivy) scans dependencies, container images, filesystems, secrets, misconfigurations, licenses, and SBOMs.
- [OSV-Scanner](https://github.com/google/osv-scanner) scans lockfiles and SBOMs using OSV vulnerability data, including Cargo and npm ecosystems.
- [OWASP ZAP](https://github.com/zaproxy/zaproxy) provides automated web-application security scanning.

### 12.2 Riverside OS opportunity

Add repeatable security evidence for Rust, npm, container, deployment, and HTTP surfaces without allowing tools to modify dependencies automatically.

### 12.3 Recommended rollout

#### Stage A: Reporting only

- generate CycloneDX or SPDX SBOM artifacts for release-relevant components;
- scan Cargo and npm lockfiles;
- scan container images and deployment files;
- scan for committed secrets and unsafe configuration;
- run a ZAP baseline against an isolated test environment;
- record findings by component, severity, exploitability, and fix availability.

#### Stage B: Controlled gating

Only after baseline triage and documented exception handling:

- block confirmed critical issues in shipped components;
- expand to high-severity issues with an available safe remediation;
- keep false-positive and accepted-risk exceptions owner-identified and time-bounded;
- require human review for dependency upgrades.

### 12.4 Rules

- Do not run active ZAP scans against production without explicit authorization.
- Do not expose production credentials or customer data to scanners.
- Do not fail releases on an untriaged legacy baseline.
- Do not auto-fix manifests, lockfiles, Dockerfiles, or deployment scripts.
- Security tools complement code review, authorization tests, and payment-provider obligations; they do not replace them.

### 12.5 Acceptance criteria

- Results are reproducible from the exact commit and release inputs.
- SBOMs are stored with build provenance.
- Duplicate findings from multiple scanners are normalized.
- Exception and remediation workflows have owners and dates.
- CI runtime and external database availability do not make builds unpredictably fail.

---

## 13. Capability plan: Encrypted backup replication

### 13.1 Project

[Kopia](https://github.com/kopia/kopia) provides encrypted, incremental, deduplicated snapshots to local and remote storage targets.

### 13.2 Riverside OS opportunity

Use Kopia to copy and retain already verified backup artifacts, such as:

- PostgreSQL logical or physical backup outputs produced by approved Riverside OS procedures;
- WAL archive packages where the recovery design supports them;
- configuration exports with secrets handled under the existing credential policy;
- required document or media object backups;
- recovery manifests and verification evidence.

### 13.3 Critical boundary

Kopia must not snapshot a live PostgreSQL data directory as a substitute for a database-aware backup. Riverside OS first produces a consistent, verified backup artifact; Kopia then encrypts, deduplicates, retains, and replicates that artifact.

### 13.4 Operational requirements

- repository credentials and recovery keys stored separately from the Main Hub;
- immutable or object-locked remote retention where supported and approved;
- bandwidth limits and scheduling that do not affect store operations;
- regular integrity verification;
- documented full and partial restore procedures;
- periodic restore drills to clean infrastructure;
- explicit retention across local, off-site, and archival tiers;
- monitoring for age of newest successful verified copy.

### 13.5 Acceptance criteria

- A backup can be restored without the original Main Hub or its credential store.
- PostgreSQL recovery reaches the documented recovery point and passes integrity checks.
- Encryption keys, storage credentials, and data are not co-located as a single failure domain.
- Failed or stale replication is visible and actionable.
- Recovery time and recovery point objectives are measured, not assumed.

---

## 14. Capability plan: Database audit evidence

### 14.1 Project

[pgAudit](https://github.com/pgaudit/pgaudit) adds detailed PostgreSQL session and object audit logging.

### 14.2 Riverside OS opportunity

Use pgAudit as a defense-in-depth source for activity that application logs cannot fully observe, such as:

- schema and migration changes;
- role and privilege changes;
- direct administrative access;
- selected reads or writes against especially sensitive objects;
- unexpected access outside normal Riverside OS service identities.

### 14.3 Boundaries

- Application-level audit records remain the primary business explanation because they retain staff identity, workflow context, reasons, and domain meaning.
- pgAudit is not a replacement for permission middleware or domain audit tables.
- Parameter logging should remain disabled where it could expose customer, credential, payment, or message data.
- Audit categories and objects must be allowlisted; broad statement logging can create excessive volume and sensitive-data exposure.

### 14.4 Acceptance criteria

- Required PostgreSQL extension compatibility is proven for the exact production version.
- Log volume is measured under realistic activity.
- Retention, access, export, and incident-review procedures are documented.
- Sensitive values are absent from captured evidence.
- Main Hub storage pressure and log rotation failure modes are tested.

---

## 15. Capability plan: Read-only synchronized clients

### 15.1 Project

[ElectricSQL](https://github.com/electric-sql/electric) synchronizes defined PostgreSQL read models to local applications over HTTP using Shapes.

### 15.2 Potential Riverside OS uses

- customer-facing display with live cart presentation;
- handheld product and availability browsing;
- wedding-party portal read views;
- low-latency operational dashboards;
- offline-tolerant reference data where stale state is visibly bounded.

### 15.3 Strict scope

ElectricSQL should be evaluated only as a **read-path projection mechanism**. It must not become a write path for:

- tender or payment state;
- pricing, discount, or tax decisions;
- stock changes or reservations;
- receiving or fulfillment completion;
- returns, refunds, or exchanges;
- staff permissions or identity;
- authoritative customer consent.

### 15.4 Security model

- Publish purpose-built projections, not unrestricted operational tables.
- Exclude secrets, payment data, PIN material, internal notes, and unnecessary personal information.
- Scope every projection to the authenticated customer, wedding member, device, register, location, or staff permission context.
- Treat synchronized data as potentially stale and show freshness when it affects staff decisions.
- Fetch authoritative state from Riverside OS before any mutation or financially meaningful presentation.

### 15.5 Adoption gate

Do not add ElectricSQL until a specific client has requirements that cannot be met cleanly with existing APIs, SSE, cache, or local state. The additional replication and authorization surface must be justified by measured user value.

---

## 16. Capability plan: Recommendation and relevance ranking

### 16.1 Project

[Metarank](https://github.com/metarank/metarank) supports learning-to-rank, recommendations, and personalization using behavioral events and a separate serving layer.

### 16.2 Potential Riverside OS uses

- complementary product suggestions;
- wedding-party ensemble recommendations;
- re-ranking of catalog search results;
- staff-assisted alternatives for unavailable items;
- customer-specific suggestions where consent and policy permit.

### 16.3 Authority and privacy rules

- PostgreSQL remains authoritative for product state, current price, tax category, availability, and sellability.
- Metarank may return identifiers and scores only; Riverside OS hydrates and revalidates products before display.
- Recommendation events must avoid unnecessary personal data.
- Customer-specific personalization requires a documented consent and retention basis.
- Recommendations need visible explanations appropriate to the user, especially when staff rely on them.
- Recommendation output cannot silently change price, discount, product eligibility, or fulfillment promises.

### 16.4 Adoption gate

Defer implementation until Riverside OS has:

- enough clean, representative interaction data;
- stable event definitions;
- product and variation identity quality;
- consent and retention decisions;
- offline evaluation metrics and a non-personalized baseline;
- a measurable business question that ranking is expected to improve.

---

## 17. Conditional projects

### 17.1 Easy!Appointments

[Easy!Appointments](https://github.com/alextselegidis/easyappointments) is a self-hosted GPL-3.0 scheduling application with a REST API and webhooks.

It may be useful as a contained public booking channel if Riverside OS needs a rapid external booking experience. It is not recommended as the core scheduling system because it introduces another scheduling database and operating stack.

If evaluated:

- Riverside OS remains authoritative for staff, services, capacity, and appointment state.
- External bookings enter through an idempotent integration adapter.
- Conflicts are resolved by Riverside OS rules.
- Cancellation and rescheduling events are correlated and replay-safe.
- License, branding, customer-data, and upgrade obligations are reviewed.

Prefer extending the existing Riverside OS appointment architecture when the effort is comparable.

### 17.2 Valkey

[Valkey](https://github.com/valkey-io/valkey) is a BSD-licensed Redis-compatible data store and a potential future vendor-neutral infrastructure option.

This is not an immediate feature enhancement. Evaluate it only during a planned Redis/cache/job infrastructure review. Migration must be tested against the exact Riverside OS production version and data format. Valkey documents compatibility with Redis OSS 7.2 and earlier while warning that Redis 7.4 and later data files are not directly compatible.

Required evaluation areas include:

- Rust client and command compatibility;
- persistence and recovery behavior;
- job-queue and distributed-lock semantics;
- deployment scripts and Windows/Main Hub operations;
- monitoring and alert parity;
- rollback using a tested export/import path.

---

## 18. Projects to avoid or constrain

### 18.1 Do not add another business suite

Do not embed or synchronize a second ERP, POS, CRM, commerce engine, or inventory system such as Odoo, ERPNext, Medusa, or Vendure merely to gain isolated features. These systems duplicate authoritative concepts and would create ongoing reconciliation, permissions, upgrade, and support costs.

### 18.2 Do not duplicate existing platform capabilities

Avoid introducing a second core for capabilities already served by Riverside OS unless a measured limitation justifies replacement:

- another reporting platform beside Cube/Insights;
- another search engine beside PostgreSQL and Meilisearch;
- another vector database beside PostgreSQL/pgvector;
- another message/inbox suite beside the current Mailbox and Podium integration;
- another notification workflow core beside current notification and transactional outbox patterns;
- another staff identity provider that conflicts with Riverside OS Staff Access, Manager Access, Access PIN, and profile synchronization.

### 18.3 Constrain open-core products

Projects such as Documenso, Formbricks, Chatwoot, and Novu may publish substantial open-source code while reserving some capabilities for commercial editions or applying network-copyleft terms. Before adoption, verify:

- exact edition and version;
- license for source, images, SDKs, and embedded components;
- hosted-service and network-use obligations;
- branding and white-label limits;
- API, SSO, audit, retention, and backup availability;
- exportability if commercial features are later removed.

Formbricks is only worth revisiting if surveys become a strategic product requirement. Chatwoot and Novu overlap current Riverside OS capabilities and are not recommended now.

### 18.4 Do not use non-production community licenses in production

Cal.com's `cal.com` repository currently directs personal/non-production self-hosters to its community path. It should not be treated as an approved production dependency without a fresh license and commercial-use review.

---

## 19. Reference integration architecture

```text
                         +--------------------------+
                         |  Staff / customer client |
                         +------------+-------------+
                                      |
                                      v
                         +--------------------------+
                         | Riverside OS API and RBAC|
                         +------------+-------------+
                                      |
                 +--------------------+--------------------+
                 |                    |                    |
                 v                    v                    v
       +------------------+  +------------------+  +------------------+
       | Domain services  |  | Integration      |  | Read projections |
       | and transactions |  | adapters/outbox  |  | and search       |
       +--------+---------+  +--------+---------+  +--------+---------+
                |                     |                     |
                v                     v                     v
       +------------------+  +------------------+  +------------------+
       | PostgreSQL       |  | Bounded OSS      |  | Bounded OSS      |
       | source of truth  |  | capability svc   |  | read/rank svc    |
       +------------------+  +------------------+  +------------------+
                                      |
                                      v
                         +--------------------------+
                         | Webhooks/events validated|
                         | back through ROS adapter |
                         +--------------------------+
```

### Required adapter pattern

Each service integration should expose a small Riverside OS interface rather than allowing project-specific APIs to spread through the codebase. The adapter owns:

- configuration validation;
- provider client and version compatibility;
- timeout and retry policy;
- request and response validation;
- idempotency and event ordering;
- mapping between external and internal identifiers;
- error classification and staff-safe messages;
- health, metrics, tracing, and audit evidence;
- disable and migration behavior.

Business rules remain in `server/src/logic/` or established services, not in route handlers or provider adapters.

---

## 20. Failure-mode policy

| Capability | External service unavailable | Required Riverside OS behavior |
| --- | --- | --- |
| PDF rendering | Gotenberg down | Save authoritative quote version; show generation pending/failed; retry safely |
| Signatures | Documenso down | Preserve unsigned workflow; no false acceptance; retry or cancel explicitly |
| Barcode decode | Camera/library failure | Allow manual code entry; no inventory or fulfillment mutation |
| Upload | tusd down | Preserve draft and resumable intent; unrelated workflows remain available |
| Image transform | imgproxy down | Preserve original; show safe placeholder or original only if policy permits |
| Feature flags | flagd down | Use explicit safe defaults; financially sensitive behavior fails closed |
| Tracing | Collector/Jaeger down | Drop/buffer within limits; never fail a business request |
| Security scanner | vulnerability service down | Report scan unavailable; follow documented CI policy, not an implicit bypass |
| Backup replication | Kopia target down | Keep verified local backup; alert on replica age; retry without deleting source |
| Database audit | audit sink pressure | Protect database availability; alert and retain defined local evidence |
| Read synchronization | ElectricSQL down | Fall back to authoritative API where designed; block unsafe stale mutations |
| Ranking | Metarank down | Use deterministic non-personalized ordering |

---

## 21. Security, privacy, and compliance requirements

Every implementation under this plan must include:

- a documented data-flow diagram;
- a minimum-data inventory by field and purpose;
- classification of personal, payment, credential, financial, and operational data;
- secret storage and rotation design;
- service-to-service authentication;
- TLS requirements for local and remote links;
- request size, rate, type, and timeout limits;
- signed webhook verification or an equivalent authenticated callback mechanism;
- replay protection and idempotency;
- role-scoped administrative access;
- retention, deletion, backup, and export policies;
- vulnerability and image update ownership;
- incident disable and credential-revocation procedures;
- evidence that Access PINs and payment data cannot enter telemetry, logs, documents, media metadata, or external event payloads.

Open-source availability does not establish PCI, privacy, accessibility, records-retention, or legal compliance.

---

## 22. Licensing and dependency governance

Before adding any project:

1. Record the exact repository, version, artifact, container digest, and license.
2. Verify licenses for the server, client SDK, browser bundle, Docker image, fonts, templates, and bundled assets separately.
3. Review network-copyleft obligations for AGPL components.
4. Confirm whether embedding, modification, hosted use, redistribution, and white-labeling are permitted.
5. Generate or update the SBOM and attribution inventory.
6. Define upgrade, security advisory, end-of-life, and fork/exit ownership.
7. Pin releases and container digests; do not deploy floating `latest` tags.
8. Preserve source and notice obligations in distributed Riverside OS packages where required.

Permissive licensing is preferred, but architectural fit, maintenance health, and security remain equally important.

---

## 23. Deployment and operations requirements

Every service deployed with Riverside OS needs:

- a supported version and compatibility matrix;
- pinned install artifacts and integrity verification;
- health and readiness checks;
- startup, shutdown, restart, and dependency ordering;
- CPU, memory, storage, and network budgets;
- log rotation and telemetry limits;
- backup and restore coverage where the service stores durable state;
- upgrade and rollback runbooks;
- failure injection or outage tests;
- Main Hub installation and repair integration where applicable;
- a remote-host option when local workload would risk POS performance;
- ownership for security updates and incident response.

Stateless rendering, proxying, or scanning services should remain stateless. Durable business history belongs in Riverside OS; a provider's required operational state should be minimized, backed up, and exportable.

---

## 24. Phased roadmap

### Phase 0: Governance, evidence, and observability

**Purpose:** Improve safety and diagnostic capability before adding customer-facing services.

- establish the license and dependency decision template;
- add Trivy and OSV-Scanner in reporting-only mode;
- generate release-relevant SBOM artifacts;
- run a safe ZAP baseline in an isolated test environment;
- route existing OTLP output through a Collector into Jaeger in development or staging;
- test telemetry redaction and resource usage;
- define service version pinning, health, backup, and rollback standards.

**Exit gate:** Findings are triaged, telemetry is confirmed free of prohibited data, and no production business request depends on the new infrastructure.

### Phase 1: Two bounded product pilots

#### Pilot A: Gotenberg quote PDF

- define the native quote lifecycle and immutable snapshot contract;
- build one approved server-rendered quote template;
- render through Gotenberg;
- store document identity, hash, renderer version, and generation result;
- test exact financial agreement and rendering failure behavior.

#### Pilot B: Existing CameraScanner extension

- extend the existing permission-gated mobile scanning surface;
- decode locally and resolve through the authoritative API;
- include manual fallback and duplicate/unknown handling;
- validate on representative store devices.

**Current status:** Register now provides an always-visible camera action beside product search and routes decoded codes through the existing Register scan path. Source contracts, TypeScript, lint, and Help gates pass. Full browser execution and representative iPad/phone camera certification remain required before treating the workflow as production-verified.

**Exit gate:** Both pilots are supportable, documented, measurable, and removable without data loss.

### Phase 2: Controlled rollout and document acceptance

- establish OpenFeature and flagd using one low-risk feature;
- add pilot targeting and kill-switch procedures;
- only after quote lifecycle stability, evaluate Documenso signing;
- prove webhook idempotency, evidence export, retention, and license fit;
- design training-mode data isolation separately from feature flag presentation.

**Exit gate:** Flags fail safely, signed document state is auditable, and signatures cannot create financial state without explicit Riverside OS confirmation.

### Phase 3: Governed media pipeline and recovery improvement

- introduce Uppy, tusd, and imgproxy as one end-to-end media capability;
- add quarantine, validation, malware scanning, EXIF policy, signed access, and retention;
- pilot Kopia replication of verified backup artifacts;
- run a documented off-site restore drill;
- evaluate narrowly scoped pgAudit logging after volume tests.

**Exit gate:** Media privacy and recovery behavior are proven, and Main Hub resource limits remain healthy.

### Phase 4: New client and intelligence capabilities

- evaluate ElectricSQL for one justified permission-scoped read client;
- create privacy-safe event definitions and offline evaluation for Metarank;
- add recommendation ranking only if it materially outperforms a deterministic baseline;
- revisit appointment-channel or Valkey options only from a separate approved business case.

**Exit gate:** Each capability demonstrates measurable value greater than its replication, privacy, and operations cost.

---

## 25. Proposed first 90-day sequence

This sequence assumes separate approval for each implementation task and intentionally avoids deploying many new services at once.

### Days 1-30: Safety foundation

- document the open-source intake checklist and owner model;
- baseline Trivy and OSV findings without CI gating;
- generate SBOMs for server, client, desktop, and shipped container inputs;
- connect existing OTLP output to a development/staging Collector and Jaeger;
- verify telemetry redaction and measure resource use;
- select the first quote use case and the first handheld workflow.

### Days 31-60: Product prototypes

- implement a Gotenberg-backed quote PDF prototype from an immutable server snapshot;
- test cent-level agreement, pagination, print, email attachment, and renderer outage behavior;
- extend the existing CameraScanner into Register catalog lookup and receiving verification;
- conduct in-store device, lighting, camera-permission, and accessibility testing;
- write staff-facing workflow documentation for any pilot entering staff testing.

### Days 61-90: Pilot hardening and decision

- add explicit health, metrics, trace, timeout, and rollback behavior to both pilots;
- complete security and license review;
- collect staff workflow time, failure rate, and support feedback;
- decide separately whether to productionize, revise, or remove each pilot;
- if broader rollout is approved, establish OpenFeature before expanding scope;
- do not begin Documenso until the native quote lifecycle is accepted.

---

## 26. Validation and release gates

Each implementation should run the smallest targeted checks first, followed by broader checks proportional to risk.

### All implementations

- formatting and strict type checks for affected packages;
- focused unit and integration tests;
- configuration validation and missing-service behavior;
- authentication, authorization, and audit-path tests;
- dependency/license scan and SBOM update;
- structured log and trace redaction tests;
- service outage, timeout, retry, duplicate, and rollback tests;
- updated engineering and operations documentation.

### Staff-facing workflows

- targeted Playwright specifications for the changed journey;
- keyboard, touch, screen-reader, and responsive-layout checks;
- in-app Help manual updates and `npm run check:help-impact`;
- screenshot specifications and refreshed images where affected;
- clear staff wording using Riverside OS terminology.

### Financial or inventory-adjacent workflows

- exact cent-level and quantity-level server assertions;
- negative authorization and Manager Access tests;
- transaction-bound mutation verification;
- duplicate and replay tests;
- authoritative API revalidation before any mutation;
- full required backend, migration, and affected E2E validation;
- live controlled drills where hardware, network outage, printing, recovery, or provider behavior matters.

### Production enablement

- exact version and artifact provenance;
- CI evidence for the exact release commit;
- deployment, health, upgrade, rollback, backup, and restore runbooks;
- representative Main Hub resource measurements;
- named operational owner and update cadence;
- feature disable path tested before rollout;
- no inference that local source success proves deployed or provider behavior.

---

## 27. Success measures

Candidate measures should be selected before each pilot.

| Capability | Example success measures |
| --- | --- |
| Quote PDFs | preparation time, revision rate, total mismatch rate, delivery failure rate |
| Signatures | time to acceptance, completion rate, support contacts, evidence export success |
| Barcode workflows | scan success, manual fallback, items processed per minute, correction rate |
| Media uploads | successful completion, resume success, mobile completion time, rejected unsafe files |
| Feature flags | safe pilot duration, rollback time, stale flag count, configuration incidents |
| Tracing | time to root cause, percentage of key flows traceable, sensitive-data violations |
| Security scans | confirmed issues remediated, triage age, false-positive rate, SBOM coverage |
| Backup replication | newest verified copy age, restore success, measured RPO and RTO |
| Database audit | actionable coverage, log volume, sensitive-data exposure, review time |
| Read synchronization | freshness, reconnect recovery, API load reduction, authorization defects |
| Recommendations | offline ranking lift, conversion or attach-rate lift, opt-out and complaint rate |

No pilot should be judged solely by whether the software can be installed.

---

## 28. Decision record template

Create a decision record before approving any candidate:

```text
Project and exact version:
Riverside OS problem being solved:
Why existing ROS capability is insufficient:
Authoritative data boundaries:
Data sent to or stored by the project:
License and redistribution review:
Security review:
Main Hub or remote hosting decision:
Resource measurements:
Failure and offline behavior:
Backup, export, upgrade, and rollback plan:
Targeted validation:
Staff documentation impact:
Owner and review date:
Pilot success measures:
Production approval:
```

---

## 29. Open decisions

The following questions should be answered only when the relevant phase is authorized:

1. Which native quote type should be first: wedding, retail, alteration, or special order?
2. Which documents require a signature rather than simple acknowledgment or staff-recorded acceptance?
3. Where will generated documents and media originals be stored and retained?
4. Which representative phones, tablets, scanners, and store networks define handheld support?
5. Does training mode require a separate database, tenant, schema, or fully synthetic dataset?
6. Which services belong on the Main Hub versus an approved remote operations host?
7. What telemetry retention and sampling meet diagnostic needs without exposing customer data?
8. What recovery point and recovery time objectives must Kopia-backed off-site copies prove?
9. Which database events justify pgAudit volume beyond existing application-level audit records?
10. Which future client has a measured need for ElectricSQL rather than existing APIs and SSE?
11. What consent, retention, and fairness rules apply before individualized recommendations?

---

## 30. Final recommendation

Proceed by capability, not by platform acquisition.

The recommended near-term order is:

1. establish reporting-only supply-chain security and SBOMs;
2. make existing OpenTelemetry traces searchable in development/staging;
3. prototype Gotenberg for one immutable, financially exact quote PDF;
4. extend and certify the existing CameraScanner in one low-risk handheld workflow;
5. introduce OpenFeature before expanding pilots or creating training mode;
6. add Documenso only after Riverside OS owns a complete native quote lifecycle;
7. add the media pipeline and backup replication after operating standards are proven;
8. reserve ElectricSQL and Metarank for separately justified future products.

This sequence brings visible improvements while protecting the architecture that matters most: Riverside OS remains the only authority for financial truth, inventory truth, staff permission, customer identity, and fulfillment state.

---

## 31. References

### Riverside OS

- [Repository overview](../README.md)
- [POS Register full audit](reviews/POS_REGISTER_FULL_AUDIT_2026-08-04.md)
- [Production hardening guide](PRODUCTION_HARDENING_GUIDE.md)
- [Observability, tracing, and OpenTelemetry](OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md)
- [Search and pagination](SEARCH_AND_PAGINATION.md)
- [Hardware management](HARDWARE_MANAGEMENT.md)
- [Appointments and calendar](APPOINTMENTS_AND_CALENDAR.md)
- [Transactions and Wedding Fulfillment Orders](TRANSACTIONS_AND_WEDDING_ORDERS.md)

### Primary project sources

- [Gotenberg](https://github.com/gotenberg/gotenberg)
- [Documenso documentation](https://docs.documenso.com/) and [source](https://github.com/documenso/documenso)
- [`html5-qrcode`](https://github.com/mebjas/html5-qrcode)
- [Uppy](https://github.com/transloadit/uppy)
- [tusd](https://github.com/tus/tusd)
- [imgproxy](https://github.com/imgproxy/imgproxy)
- [OpenFeature SDKs](https://openfeature.dev/docs/reference/sdks/)
- [flagd](https://github.com/open-feature/flagd)
- [OpenTelemetry Collector Contrib](https://github.com/open-telemetry/opentelemetry-collector-contrib)
- [Jaeger](https://github.com/jaegertracing/jaeger)
- [Trivy](https://github.com/aquasecurity/trivy)
- [OSV-Scanner](https://github.com/google/osv-scanner)
- [OWASP ZAP](https://github.com/zaproxy/zaproxy)
- [Kopia](https://github.com/kopia/kopia)
- [pgAudit](https://github.com/pgaudit/pgaudit)
- [ElectricSQL](https://github.com/electric-sql/electric)
- [Metarank](https://github.com/metarank/metarank)
- [Easy!Appointments](https://github.com/alextselegidis/easyappointments)
- [Valkey](https://github.com/valkey-io/valkey) and [migration notes](https://valkey.io/topics/migration/)
