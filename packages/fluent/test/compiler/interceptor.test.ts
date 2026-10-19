// SPDX-License-Identifier: GPL-3.0-or-later

import { compile, messages, only } from "./helpers";

const wizard = (options: string) => `Interceptor({ name: 'W', ${options} })\n`;
const answer = (options: string) => wizard(`answers: [{ $id: Now.ID['a'], ${options} }]`);

describe("Interceptor()", () => {
  it("compiles a bare wizard with every field empty", () => {
    const result = compile(wizard(""));
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_wizard")[0]).toMatchObject({
      name: "W",
      question: "",
      back_panel: "",
      next_panel: "",
      intercepts: "",
      sys_policy: "",
    });
  });

  it("keeps the given type when it has no code and joins roles in order", () => {
    const result = compile(answer("type: 'custom', targetUrl: 'u', roles: ['itil', 'admin', 'itil']"));
    expect(messages(result, "hint")).toEqual([]);
    expect(only(result, "sys_wizard_answer")[0]).toMatchObject({ type: "custom", roles: "itil,admin,itil", order: "100", active: "true" });
  });

  it.each([
    ["targetUrl: ''", "Answer type 'answer' typically sets 'targetUrl' — this answer has none and will not navigate anywhere when selected."],
    ["type: 'leadingQuestion'", "Answer type 'leadingQuestion' typically sets 'nextQuestion' — this answer has none and will not advance to another question."],
    ["type: 'button'", "Answer type 'button' typically sets 'buttonLabel' — this answer has none and will render an unlabeled button."],
    ["type: 'externalChoice'", "Answer type 'externalChoice' typically sets 'table' (and 'element') — this answer has none and will not source any choices."],
    ["type: 'externalChoice', table: 'incident'", "Answer type 'externalChoice' sets 'table' but is missing 'element'; the platform requires both to source dynamic choices."],
    ["type: 'yesNo'", "Answer type 'yesNo' captures user input via 'payloadName' at runtime; set 'payloadName' to a meaningful identifier so the collected value is accessible."],
  ])("hints for %s", (options, message) => {
    const result = compile(answer(options));
    expect(messages(result)).toEqual([]);
    expect(messages(result, "hint")).toEqual([message]);
  });

  it.each([
    [
      "type: 'button', buttonLabel: 'Go', answer: 'hidden'",
      ["The 'answer' field is stored but not displayed when type is 'button'; use 'buttonLabel' for the visible button text."],
    ],
    [
      "type: 'externalChoice', element: 'category', dependentValue: 'x'",
      [
        "Answer type 'externalChoice' sets 'element' but is missing 'table'; 'element' is ignored without 'table'.",
        "Answer type 'externalChoice' sets 'dependentValue' but 'table'/'element' are missing or incomplete; 'dependentValue' is ignored without both.",
      ],
    ],
  ])("warns for %s", (options, warnings) => {
    const result = compile(answer(options));
    expect(messages(result)).toEqual([]);
    expect(messages(result, "warning")).toEqual(warnings);
  });

  it("warns once per order that sibling answers share", () => {
    const result = compile(
      wizard(
        "answers: [{ $id: Now.ID['a'], targetUrl: 'u' }, { $id: Now.ID['b'], targetUrl: 'u' }, { $id: Now.ID['c'], targetUrl: 'u', order: 5 }, { $id: Now.ID['d'], targetUrl: 'u', order: 5 }, { $id: Now.ID['e'], targetUrl: 'u', order: 5 }]",
      ),
    );
    expect(messages(result)).toEqual([]);
    expect(messages(result, "warning")).toEqual([
      "2 answers share order 100 — display order on the instance will be unpredictable. Set distinct order values for each sibling answer.",
      "3 answers share order 5 — display order on the instance will be unpredictable. Set distinct order values for each sibling answer.",
    ]);
  });

  it.each([
    ["$id: Now.ID['w']", "Interceptor() has no property '$id'."],
    ["$meta: { installMethod: 'demo' }", "Interceptor() has no property '$meta'."],
    ["backPanel: 5", "Interceptor(): 'backPanel' must be a sys_id, a record or a Now.ref()."],
    ["nextPanel: Now.ref('sys_wizard', { name: 5 })", "Interceptor(): Now.ref() keys of 'nextPanel' must be strings."],
    ["answers: [{ $id: Now.ID['a'], nextQuestion: true }]", "Interceptor(): 'answers[].nextQuestion' must be a sys_id, a record or a Now.ref()."],
    ["answers: [{ $id: Now.ID['a'], roles: [1] }]", "Interceptor(): 'answers[].roles' must hold role names or Role() records."],
    ["answers: [{ $id: Now.ID['a'], roles: [Interceptor({ name: 'X' })] }]", "Interceptor(): 'answers[].roles' must hold roles."],
    ["answers: [{ $id: Now.ID['a'], label: 'x' }]", "Interceptor() has no property 'answers[].label'."],
  ])("rejects %s", (options, message) => {
    expect(messages(compile(wizard(options)))).toEqual([message]);
  });
});
