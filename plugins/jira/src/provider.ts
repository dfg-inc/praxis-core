import type { PraxisRichTextDocument } from "@praxis/contracts";
import type { JiraConfig } from "./config.js";

export type JiraUser = {
  accountId: string;
  displayName: string;
  emailAddress?: string;
};

export type JiraIssueLite = {
  id: string;
  key: string;
  summary: string;
  description?: unknown;
  status: string;
  issueType: string;
  labels: string[];
  parentKey?: string;
  assignee?: JiraUser;
  fields: Record<string, unknown>;
  properties: Record<string, unknown>;
};

export type JiraComment = { id: string; body: unknown; author: string };

export type JiraLink = {
  type: string;
  inwardKey: string;
  outwardKey: string;
};

export type Transition = { id: string; name: string };

export type MetadataContext = {
  epicTypeId: string;
  storyTypeId: string;
  taskTypeId: string;
  bugTypeId: string;
  workPackageTypeId?: string;
  issueTypes: { id: string; name: string }[];
  fields: { id: string; name: string }[];
  versions: { id: string; name: string }[];
  transitionsByName: Record<string, string>;
};

export type CreateIssueInput = {
  summary: string;
  issueType: string;
  description?: unknown;
  parentKey?: string;
  labels?: string[];
  fields?: Record<string, unknown>;
};

export const PRAXIS_ISSUE_PROPERTIES = [
  "praxis.managed",
  "praxis.artifactId",
  "praxis.role",
  "praxis.sourceEpic",
  "praxis.superseded",
  "praxis.supersededBy",
  "praxis.state",
  "praxis.workPackage",
  "praxis.claim",
  "praxis.requirementIds",
  "praxis.contentFingerprint",
  "praxis.baHandoff",
] as const;

export interface JiraProvider {
  readonly flavor: "cloud" | "datacenter";
  readonly config: JiraConfig;
  verifyConnection(): Promise<{
    ok: boolean;
    displayName?: string;
    version?: string;
    deploymentType?: string;
    patSupported: boolean;
    guidance?: string;
  }>;
  getServerInfo(): Promise<{
    version?: string;
    deploymentType?: string;
    baseUrl: string;
  }>;
  getCurrentUser(): Promise<JiraUser>;
  getProject(): Promise<{ key: string; name: string; id: string }>;
  getIssueTypes(): Promise<{ id: string; name: string }[]>;
  getFields(): Promise<{ id: string; name: string }[]>;
  getVersions(): Promise<{ id: string; name: string }[]>;
  createVersion(name: string): Promise<{ id: string; name: string }>;
  discoverMetadata(): Promise<MetadataContext>;
  getIssue(key: string): Promise<JiraIssueLite>;
  getIssues(jql: string): Promise<JiraIssueLite[]>;
  searchIssues(jql: string): Promise<JiraIssueLite[]>;
  getChildren(parentKey: string): Promise<JiraIssueLite[]>;
  getParent(key: string): Promise<JiraIssueLite | null>;
  createIssue(input: CreateIssueInput): Promise<{ key: string; id: string }>;
  updateIssue(key: string, fields: Record<string, unknown>): Promise<void>;
  assignIssue(key: string, accountId: string): Promise<void>;
  getTransitions(key: string): Promise<Transition[]>;
  transitionIssue(key: string, transitionIdOrName: string): Promise<void>;
  addComment(key: string, body: unknown): Promise<{ id: string }>;
  getComments(key: string): Promise<JiraComment[]>;
  addAttachment(
    key: string,
    filename: string,
    contentType: string,
    body: Uint8Array,
  ): Promise<{ id: string; filename: string }>;
  getAttachments(key: string): Promise<{ id: string; filename: string }[]>;
  createIssueLink(
    inwardKey: string,
    outwardKey: string,
    type?: string,
  ): Promise<void>;
  getIssueLinks(key: string): Promise<JiraLink[]>;
  setFixVersion(key: string, versionName: string): Promise<void>;
  setIssueProperty(key: string, propertyKey: string, value: unknown): Promise<void>;
  getIssueProperty<T = unknown>(key: string, propertyKey: string): Promise<T | undefined>;
  listIssueProperties(key: string): Promise<string[]>;
  writePraxisState(key: string, state: unknown): Promise<void>;
  readPraxisState<T = unknown>(key: string): Promise<T | undefined>;
  writeArchitectureMetadata(key: string, value: unknown): Promise<void>;
  readArchitectureMetadata<T = unknown>(key: string): Promise<T | undefined>;
  renderDescription(doc: PraxisRichTextDocument): unknown;
}
