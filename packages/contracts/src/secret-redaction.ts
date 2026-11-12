/**
 * Value-based redaction of the credentials this process holds.
 *
 * Every credential variable Praxis reads (CREDENTIAL_VARIABLES), and any credential registered when it is loaded from
 * configuration (registerCredential), is replaced by `[REDACTED:<NAME>]` wherever its exact value, or a form Praxis sends it
 * in (JSON-escaped, URL-encoded, base64, the Jira Cloud `email:token` basic credential), appears in text Praxis emits. The
 * Runtime applies it at its output boundary: every tool result and error, the protocol stream, its stderr log lines and its
 * diagnostics log (praxis-runtime secret-redaction.ts). The CLI applies it to what it prints.
 *
 * What it stops: the exact value, or a form listed above, reaching the model context through Praxis's own output by
 * accident, for example a remote error body that echoes the Authorization header, a repository file or record that
 * contains the token, or an exception message.
 *
 * What it does not stop: anything that reads the token itself. Redaction does not remove a variable from an environment that
 * was already inherited; every process started the same way as this one (the agent's own shell included, in a terminal
 * client) has the same variables, and any program running as the user, repository code Praxis starts included, can read
 * this process's initial environment (`ps -E`, `/proc/<pid>/environ`) and print the token in a form redaction does not
 * know (reversed, split, otherwise encoded). It is hygiene, not a boundary. praxis_doctor names the variables
 * (credentialExposure). Values shorter than MIN_SECRET_LENGTH are not redacted (they would mangle ordinary output); a real
 * token is longer.
 */

export const CREDENTIAL_VARIABLES = [
  "PRAXIS_JIRA_TOKEN",
  "PRAXIS_GITHUB_TOKEN",
  "PRAXIS_GITLAB_TOKEN",
  "PRAXIS_GIT_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITLAB_TOKEN",
] as const;

export const MIN_SECRET_LENGTH = 8;

/** Claude Desktop passes an optional setting left blank as the literal `${user_config.<field>}`: unset, not a credential. */
const PLACEHOLDER = /^\$\{[^}]*\}$/;

const usable = (value: string | undefined): value is string => typeof value === "string" && value.trim().length >= MIN_SECRET_LENGTH && !PLACEHOLDER.test(value.trim());

/** The environment as this process inherited it, before Praxis loaded anything from a repository. */
const inherited: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
);

/**
 * The names (never the values) of credential variables present in the environment this process inherited. Praxis never adds
 * one (a repository .env file cannot set a credential variable), so the live environment is the inherited one for these.
 */
export function inheritedCredentialVariables(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  return CREDENTIAL_VARIABLES.filter((name) => {
    const value = env[name];
    return typeof value === "string" && value.trim() !== "" && !PLACEHOLDER.test(value.trim());
  });
}

const registered = new Map<string, Set<string>>();

/** A credential loaded from configuration rather than a credential variable: redacted under `name` from now on. */
export function registerCredential(name: string, value: string | undefined): void {
  if (!usable(value)) return;
  const set = registered.get(name) ?? new Set<string>();
  set.add(value);
  registered.set(name, set);
}

/** Every form of `value` Praxis may emit or send, longest first, so a shorter form never splits a longer one. */
function formsOf(value: string): string[] {
  const forms = new Set([value, value.trim()]);
  forms.add(JSON.stringify(value).slice(1, -1));
  forms.add(encodeURIComponent(value));
  forms.add(Buffer.from(value, "utf8").toString("base64"));
  forms.add(Buffer.from(value, "utf8").toString("base64").replace(/=+$/, ""));
  return [...forms].filter((form) => form.length >= MIN_SECRET_LENGTH);
}

type Pattern = { form: string; label: string };

function patterns(): Pattern[] {
  const out: Pattern[] = [];
  const add = (name: string, value: string | undefined) => {
    if (!usable(value)) return;
    for (const form of formsOf(value)) out.push({ form, label: `[REDACTED:${name}]` });
  };
  for (const name of CREDENTIAL_VARIABLES) {
    add(name, inherited[name]);
    if (process.env[name] !== inherited[name]) add(name, process.env[name]);
  }
  // Jira Cloud sends base64(email:token) as a basic credential
  for (const token of new Set([inherited.PRAXIS_JIRA_TOKEN, process.env.PRAXIS_JIRA_TOKEN])) {
    for (const email of new Set([inherited.PRAXIS_JIRA_EMAIL, process.env.PRAXIS_JIRA_EMAIL])) {
      if (usable(token) && email?.trim()) add("PRAXIS_JIRA_TOKEN", `${email.trim()}:${token.trim()}`);
    }
  }
  for (const [name, values] of registered) for (const value of values) add(name, value);
  return out.sort((a, b) => b.form.length - a.form.length);
}

/** `text` with every credential value this process holds replaced by `[REDACTED:<NAME>]`. */
export function redactCredentials(text: string): string {
  if (!text) return text;
  let out = text;
  for (const { form, label } of patterns()) if (out.includes(form)) out = out.split(form).join(label);
  return out;
}

/** True when `text` contains any credential value this process holds, in any form redactCredentials replaces. */
export function containsCredential(text: string): boolean {
  return patterns().some(({ form }) => text.includes(form));
}

/**
 * A copy of `value` with every string (keys included) redacted. Plain objects and arrays are copied; an Error becomes its
 * redacted message; anything else is returned as it is.
 */
export function redactCredentialsDeep<T>(value: T): T {
  const list = patterns();
  if (list.length === 0) return value;
  const redact = (text: string): string => {
    let out = text;
    for (const { form, label } of list) if (out.includes(form)) out = out.split(form).join(label);
    return out;
  };
  const seen = new WeakMap<object, unknown>();
  const walk = (input: unknown): unknown => {
    if (typeof input === "string") return redact(input);
    if (!input || typeof input !== "object") return input;
    if (seen.has(input)) return seen.get(input);
    if (input instanceof Error) {
      const copy = new Error(redact(input.message));
      copy.name = input.name;
      seen.set(input, copy);
      return copy;
    }
    if (Array.isArray(input)) {
      const copy: unknown[] = [];
      seen.set(input, copy);
      for (const item of input) copy.push(walk(item));
      return copy;
    }
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) return input;
    const copy: Record<string, unknown> = {};
    seen.set(input, copy);
    for (const [key, inner] of Object.entries(input as Record<string, unknown>)) copy[redact(key)] = walk(inner);
    return copy;
  };
  return walk(value) as T;
}
