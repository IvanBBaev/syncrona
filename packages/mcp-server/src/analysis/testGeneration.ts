export type AtfTestMethod = {
  name: string;
  args: string[];
};

export type AtfTestSuggestion = {
  scriptIncludeName: string;
  className: string;
  isClass: boolean;
  clientCallable: boolean;
  methods: AtfTestMethod[];
  atfTestScript: string;
  instructions: string[];
};

const RESERVED_MEMBERS = new Set(["initialize", "type", "prototype", "constructor"]);

function sanitizeIdentifier(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/[A-Za-z_$][A-Za-z0-9_$]*/);
  return match ? match[0] : "";
}

function parseArgList(rawArgs: string): string[] {
  return rawArgs
    .split(",")
    .map((part) => sanitizeIdentifier(part))
    .filter((part) => part.length > 0);
}

function detectClassName(script: string, fallback: string): { className: string; isClass: boolean } {
  const es6 = script.match(/class\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
  if (es6) {
    return { className: es6[1], isClass: true };
  }

  const classCreate = script.match(/(?:var|const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*Class\.create\s*\(\s*\)/);
  if (classCreate) {
    return { className: classCreate[1], isClass: true };
  }

  const prototypeAssign = script.match(/([A-Za-z_$][A-Za-z0-9_$]*)\.prototype\s*=/);
  if (prototypeAssign) {
    return { className: prototypeAssign[1], isClass: true };
  }

  const fallbackName = sanitizeIdentifier(fallback);
  return { className: fallbackName || "ScriptInclude", isClass: false };
}

function collectMethods(script: string): AtfTestMethod[] {
  const found = new Map<string, AtfTestMethod>();

  // prototype object members: methodName: function(a, b) {
  const objectMethod = /([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*function\s*\(([^)]*)\)/g;
  // this.methodName = function(a, b) {
  const thisMethod = /this\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*function\s*\(([^)]*)\)/g;
  // ES6 class method: methodName(a, b) {
  const es6Method = /(?:^|\n)\s*(?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(([^)]*)\)\s*\{/g;

  const register = (name: string, rawArgs: string): void => {
    const clean = sanitizeIdentifier(name);
    if (!clean || RESERVED_MEMBERS.has(clean) || found.has(clean)) {
      return;
    }
    if (clean.startsWith("_")) {
      return;
    }
    found.set(clean, { name: clean, args: parseArgList(rawArgs) });
  };

  let match: RegExpExecArray | null;
  while ((match = objectMethod.exec(script)) !== null) {
    register(match[1], match[2]);
  }
  while ((match = thisMethod.exec(script)) !== null) {
    register(match[1], match[2]);
  }
  while ((match = es6Method.exec(script)) !== null) {
    if (match[1] === "function") {
      continue;
    }
    register(match[1], match[2]);
  }

  return [...found.values()];
}

function buildAtfTestScript(
  className: string,
  methods: AtfTestMethod[]
): string {
  const lines: string[] = [];
  lines.push("(function(outputs, steps, params, stepResult, assertEqual) {");
  lines.push(`  // Auto-generated ATF skeleton for Script Include: ${className}`);
  lines.push(`  var subject = new ${className}();`);
  lines.push("");

  if (methods.length === 0) {
    lines.push("  // No public methods detected. Add manual assertions below.");
    lines.push("  // assertEqual({ name: 'subject is created', shouldbe: true, value: !!subject });");
  } else {
    for (const method of methods) {
      const argPlaceholders = method.args.map((arg) => `/* ${arg} */ null`).join(", ");
      lines.push(`  // --- ${method.name}(${method.args.join(", ")}) ---`);
      lines.push(`  var result_${method.name} = subject.${method.name}(${argPlaceholders});`);
      lines.push(
        `  assertEqual({ name: '${method.name} returns expected value', shouldbe: /* expected */ null, value: result_${method.name} });`
      );
      lines.push("");
    }
  }

  lines.push("  stepResult.setSuccess();");
  lines.push("})(outputs, steps, params, stepResult, assertEqual);");
  return lines.join("\n");
}

export function suggestAtfTest(params: {
  scriptIncludeName: string;
  script: string;
  clientCallable?: boolean;
}): AtfTestSuggestion {
  const scriptIncludeName = (params.scriptIncludeName || "").trim();
  const script = typeof params.script === "string" ? params.script : "";
  const { className, isClass } = detectClassName(script, scriptIncludeName);
  const methods = collectMethods(script);
  const atfTestScript = buildAtfTestScript(className, methods);

  const instructions = [
    "Create a new ATF Test record (sys_atf_test) named '" + (scriptIncludeName || className) + " - unit tests'.",
    "Add a 'Run Server Side Script' step (sys_atf_step) to the test.",
    "Paste the generated atfTestScript into the step's script field.",
    "Replace each '/* expected */ null' assertion target and '/* arg */ null' placeholder with real test data.",
    "Run the test from the ATF Test form to validate the Script Include behavior.",
  ];

  return {
    scriptIncludeName: scriptIncludeName || className,
    className,
    isClass,
    clientCallable: params.clientCallable === true,
    methods,
    atfTestScript,
    instructions,
  };
}
