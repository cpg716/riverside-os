# Riverside OS — Post-v0.4.7 Operationalization Master Plan

## Purpose

This document defines the next operationalization phase for Riverside OS after the successful release of v0.4.7.

The focus of this phase is not major new features.
The focus is:

- operational trust
- accounting confidence
- hardware reliability
- reporting accuracy
- deployment safety
- security and governance
- long-term scalability

The system has now reached a stage where correctness, auditability, and operational resilience are more important than feature velocity.

---

# 1. Real-World Hardware & Store-Floor Validation Plan

## Objective

Validate that Riverside OS functions correctly with real hardware, real operators, and real accounting workflows under actual store conditions.

This phase exists to catch the class of issues that automated tests cannot fully validate:

- terminal timing problems
- printer rendering issues
- Windows workstation quirks
- staff workflow confusion
- register reconciliation drift
- hardware retry/recovery edge cases
- operational sequencing issues

---

# Hardware Validation Matrix

## Helcim Terminal Validation

### Required Scenarios

#### Standard Card Sale
Validate:
- successful approval
- terminal prompts
- timeout handling
- approval recording
- receipt generation
- QBO tender evidence

#### Split Tender Sale
Validate:
- partial cash + card
- multiple cards
- tender remainder handling
- accurate register totals
- accurate QBO tender totals

#### Cancelled Transaction
Validate:
- operator cancellation
- timeout recovery
- stale attempt cleanup
- no duplicate provider rows

#### Retry Flow
Validate:
- failed terminal attempt
- retry from same lane
- retry from different terminal
- stale provider state cleanup

#### Refunds
Validate:
- same-day refund
- cross-day refund
- split-card refund
- governed migration refund
- queue updates
- QBO balancing

### Required Evidence

Capture:
- screenshots
- terminal photos
- receipts
- provider transaction IDs
- QBO proposal screenshots
- register totals

---

## Receipt Printer Validation

### Thermal Printer

Validate:
- correct width
- no clipping
- barcode rendering
- logo rendering
- item alignment
- totals alignment
- refund receipts
- gift card receipts
- long receipts

### Reprint Flow

Validate:
- transaction reprint
- refund reprint
- receipt retrieval speed

### Failure Recovery

Validate:
- printer offline
- out of paper
- USB disconnect
- retry behavior

---

## Reports Printer Validation

### Reports

Validate:
- Daily Sales
- Register Reports
- QBO summaries
- Inventory reports
- Counterpoint signoff reports
- Help print support

### Print Behavior

Validate:
- no blank pages
- proper margins
- no clipped sections
- correct pagination
- dark/light mode readability

---

## Cash Drawer Validation

Validate:
- automatic opening
- manual opening
- refund opening
- open register flow
- close register flow

---

## Barcode Scanner Validation

Validate:
- POS item scan
- receiving scan
- gift card scan
- customer barcode scan
- wedding party scan
- alteration ticket scan

Validate behavior for:
- invalid barcode
- duplicate barcode
- stale barcode
- rapid scan bursts

---

## Windows Deployment Validation

### Fresh Install

Validate:
- installer launches
- ROSIE sidecar installation
- updater registration
- database connectivity
- printer detection

### Update Flow

Validate:
- updater detects new version
- updater downloads
- updater installs cleanly
- user data preserved
- no config loss

---

## Counterpoint Bridge Workstation Validation

Validate:
- bridge startup
- schema probe
- ingest flow
- offline recovery
- signoff proof
- package deployment
- Windows scheduled execution

---

# Store Workflow Validation Matrix

## Register Workflows

### Open Register

Validate:
- float entry
- incorrect float handling
- staff attribution
- open session persistence

### Close Register

Validate:
- expected cash
- refund totals
- variance handling
- audit notes
- Z-close generation
- QBO generation trigger

---

## POS Sale Workflows

### Immediate Takeaway Sale

Validate:
- correct fulfillment label
- no false balance due
- POS Retail Sale wording
- proper booked/fulfilled classification

### Special Order

Validate:
- booked revenue
- fulfillment transition
- pickup recognition
- open balance handling

### Layaway

Validate:
- deposit handling
- forfeiture handling
- fulfillment handling
- QBO treatment

### Existing Order Edit

Validate:
- adding items
- modifying unfulfilled quantities
- totals recalculation
- effective date handling

---

## Refund Workflows

### Same-Day Refund

Validate:
- negative payment rows
- queue reduction
- QBO balancing
- receipt generation

### Cross-Day Refund

Validate:
- refund liability clearing
- independent balanced journals
- reporting correctness

### Split-Tender Refund

Validate:
- card capacity enforcement
- sequential refund guidance
- per-card attribution
- provider idempotency

### Migration Refund

Validate:
- manager override
- manual terminal workflow
- audit logs
- QBO balancing
- metadata correctness

---

# Deliverables

## 1. Store Acceptance Checklist

A printable operational checklist covering:

- hardware
- workflows
- accounting
- reports
- QBO
- diagnostics
- Help Center

---

## 2. Hardware Validation Log

Track:

- workstation
- device model
- firmware
- pass/fail
- operator notes
- screenshots
- printer samples

---

## 3. Escalation Report

Immediate escalation required for:

- accounting mismatch
- duplicated payment
- lost refund
- incorrect balance due
- printer corruption
- stale provider state
- QBO imbalance

---

# 2. Operational Smoke & Store Acceptance Plan

## Objective

Create a repeatable release-acceptance workflow for future deployments.

This becomes:

- pre-release checklist
- store rollout checklist
- operator acceptance checklist
- support onboarding workflow

---

# Critical Workflows

## POS Core

Validate:
- open register
- cash sale
- rounded cash sale
- card sale
- split tender
- receipt print
- receipt reprint
- refund
- void/cancel

---

## Customer & Orders

Validate:
- customer creation
- customer search
- existing order edit
- pickup
- balance due
- fulfillment labels

---

## Inventory & Receiving

Validate:
- PO receive
- stale paperwork warnings
- retry flow
- barcode scan
- inventory adjustments

---

## Financial

Validate:
- QBO proposal generation
- balanced journals
- refund liability clearing
- store credit liability
- open deposit liability
- gift card subtype accounting

---

## Counterpoint

Validate:
- signoff proof
- imported tax warnings
- reconciliation
- imported transaction reporting

---

## Help & Diagnostics

Validate:
- Help print
- ROSIE timeout/degraded behavior
- bug reports
- diagnostics exports
- Dev Center

---

# Severity Levels

## Critical

Must pass before deployment:

- checkout
- refunds
- QBO
- register close
- inventory receive

## High

Must pass before store rollout:

- help system
- reports
- diagnostics
- updater

## Informational

- copy polish
- spacing
- labels
- animations

---

# Deliverables

- printable checklist
- pass/fail worksheet
- accounting signoff sheet
- store manager signoff sheet
- escalation template

---

# 3. Metabase & Reporting Audit Plan

## Objective

Ensure all reporting surfaces derive from canonical accounting logic.

The goal is to eliminate:

- duplicated calculations
- semantic drift
- reporting mistrust
- mismatched balances

---

# Reports To Audit

## Sales Reports

Validate:
- Daily Sales
- register summaries
- sales by employee
- sales by fulfillment
- booked vs fulfilled

---

## Liability Reports

Validate:
- refund queue
- gift cards
- store credit
- open deposits

---

## Inventory Reports

Validate:
- inventory valuation
- margin
- COGS
- restock accounting

---

## Counterpoint Reports

Validate:
- imported rows
- zero-tax semantics
- signoff reconciliation

---

# Validation Rules

Every report must reconcile against:

- transactions
- payment_transactions
- payment_allocations
- transaction_return_lines
- QBO proposals

---

# Deliverables

## Reporting Trust Matrix

Classify reports as:
- canonical
- derived
- duplicated-risk

## Accounting Crosswalk

Map:
- ROS ledger
- QBO journal lines
- Metabase reports

## Risk Register

Track:
- duplicated math
- stale logic
- semantic drift
- incorrect fulfillment classification

---

# 4. Performance & Concurrency Audit Plan

## Objective

Prepare ROS for real-world scale and multi-user concurrency.

---

# High-Risk Areas

## Frontend

Audit:
- Product Hub
- Customer Hub
- Orders
- Receiving
- Scheduler
- Counterpoint proof
- QBO proposals

---

## Backend

Audit:
- N+1 queries
- oversized payloads
- locking
- expensive joins
- duplicated aggregation logic

---

## Concurrency

Validate:
- multiple cashiers
- simultaneous refunds
- simultaneous receiving
- inventory edits
- order edits
- split refunds

---

# Deliverables

## Performance Baseline

Track:
- render times
- API latency
- payload sizes
- query durations

## Hotspot Report

Identify:
- slowest workflows
- largest queries
- race conditions
- locking risks

## Optimization Roadmap

Prioritized by:
- operational impact
- implementation safety
- accounting sensitivity

---

# 5. Security & Permissions Audit Plan

## Objective

Ensure all sensitive workflows are:

- permissioned
- auditable
- attributable
- recoverable

---

# Areas To Audit

## Financial

Validate:
- refunds
- manual migration refunds
- financial date corrections
- QBO actions

---

## Inventory

Validate:
- adjustments
- receiving overrides
- product edits

---

## Diagnostics

Validate:
- bug reports
- Dev Center
- diagnostics exports
- ROSIE logs

---

## Session Security

Validate:
- manager overrides
- PIN escalation
- session isolation
- audit logging

---

# Core Questions

## Authorization

- Who can perform the action?
- Is step-up auth required?
- Is manager override enforced?

## Auditability

- Is the action logged?
- Is the actor preserved?
- Is the reason preserved?

## Privacy

- Are secrets redacted?
- Are exports sanitized?
- Are tokens protected?

---

# Deliverables

## Permission Matrix

Role → Allowed Actions

## Audit Trail Matrix

Action → Required Logs

## Security Risk Register

Track:
- missing audit logs
- weak permissions
- override inconsistencies
- privacy risks

---

# Final Exit Criteria

Riverside OS is operationally ready when:

- accounting is trusted
- reports reconcile
- hardware workflows are reliable
- refunds are auditable
- QBO journals balance consistently
- operators can recover from failures safely
- managers can explain system behavior confidently
- support workflows are documented
- diagnostics are actionable
- release/update/install flows are repeatable

