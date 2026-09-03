---
id: PREC-async-queue-gds
title: Prefer queue for cross-service write fan-out
roles: [architect, developer]
stages: [plan, implement]
---

## Circumstances

Product GDS needed durable write fan-out between the order and billing services
without coupling their deploy cycles.

## Chosen

An asynchronous message queue between the services for write-side events.

## Rejected

Synchronous HTTP calls from order to billing on every write.

## Why

Queue backpressure and independent scaling avoided cascading timeouts during
billing incidents; the product override of the company "prefer sync within
datacenter" guidance held up in production.
