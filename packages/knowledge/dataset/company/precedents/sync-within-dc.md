---
id: PREC-company-sync-default
title: Prefer sync within a single datacenter
roles: [architect]
stages: [plan]
---

## Circumstances

Two company services in the same datacenter exchange infrequent status updates.

## Chosen

Synchronous HTTP with short timeouts.

## Rejected

Always introducing a message broker for every cross-service call.

## Why

Operational cost of a broker exceeded benefit for low-volume status traffic.
