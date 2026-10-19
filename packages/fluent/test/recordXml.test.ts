// SPDX-License-Identifier: GPL-3.0-or-later
import {
  cdataSection,
  escapeXmlAttribute,
  escapeXmlText,
  RecordXmlError,
  serializeCompositeRecordUpdate,
  serializeDeleteMultiple,
  serializeRecordUpdate,
} from "../src/recordXml";

describe("escaping", () => {
  it("escapes text and attribute values and drops invalid control characters", () => {
    expect(escapeXmlText("a & b < c > d\u0001\u000b")).toBe("a &amp; b &lt; c &gt; d");
    expect(escapeXmlText("tab\tnl\ncr\r")).toBe("tab\tnl\ncr&#13;");
    expect(escapeXmlAttribute('say "hi" & <bye>')).toBe("say &quot;hi&quot; &amp; &lt;bye&gt;");
  });

  it("splits a CDATA terminator across two sections", () => {
    expect(cdataSection("a]]>b\u0000")).toBe("<![CDATA[a]]]]><![CDATA[>b]]>");
  });
});

describe("serializeRecordUpdate", () => {
  it("emits the SDK's record_update shape", () => {
    const xml = serializeRecordUpdate({
      table: "sys_script",
      applyDefaults: true,
      fields: [
        { name: "sys_id", value: "7639380602944de9a8d47d50c22d156f" },
        { name: "sys_scope", value: "db22ea00d7ff49d9b5d64061202ea510", displayValue: "x_snc_bprobe" },
        { name: "condition", value: "" },
        { name: "description" },
        { name: "message", value: null },
        { name: "name", value: "A & B" },
        { name: "script", value: "line1\nif (a < b) {}", cdata: true },
        { name: "order", value: "100" },
      ],
    });
    expect(xml).toBe(
      [
        '<?xml version="1.0"?>',
        '<record_update table="sys_script">',
        '  <sys_script action="INSERT_OR_UPDATE" apply_defaults="true">',
        "    <sys_id>7639380602944de9a8d47d50c22d156f</sys_id>",
        '    <sys_scope display_value="x_snc_bprobe">db22ea00d7ff49d9b5d64061202ea510</sys_scope>',
        "    <condition/>",
        "    <description/>",
        "    <message/>",
        "    <name>A &amp; B</name>",
        "    <script><![CDATA[line1\nif (a < b) {}]]></script>",
        "    <order>100</order>",
        "  </sys_script>",
        "</record_update>",
      ].join("\n"),
    );
  });

  it("escapes multi-line plain text, keeps an empty display value and writes the DELETE action", () => {
    const xml = serializeRecordUpdate({
      table: "sys_ui_policy",
      action: "DELETE",
      fields: [
        { name: "script", value: "]]>", cdata: true },
        { name: "short_description", value: "a < b\r\nc", cdata: false },
        { name: "table", value: "", displayValue: "" },
      ],
    });
    expect(xml).toBe(
      [
        '<?xml version="1.0"?>',
        '<record_update table="sys_ui_policy">',
        '  <sys_ui_policy action="DELETE">',
        "    <script><![CDATA[]]]]><![CDATA[>]]></script>",
        "    <short_description>a &lt; b&#13;\nc</short_description>",
        '    <table display_value=""/>',
        "  </sys_ui_policy>",
        "</record_update>",
      ].join("\n"),
    );
  });

  it("renders further attributes after display_value, in insertion order", () => {
    const xml = serializeRecordUpdate({
      table: "sys_user_role_contains",
      fields: [
        { name: "contains", value: "abc", attributes: { name: "itil" } },
        { name: "role", value: "def", displayValue: "dv", attributes: { name: "x.m", scope: "s&" } },
        { name: "view", value: "", displayValue: "old", attributes: { display_value: "new" } },
      ],
    });
    expect(xml.split("\n").slice(3, 6)).toEqual([
      '    <contains name="itil">abc</contains>',
      '    <role display_value="dv" name="x.m" scope="s&amp;">def</role>',
      '    <view display_value="new"/>',
    ]);
    expect(() =>
      serializeRecordUpdate({ table: "t", fields: [{ name: "f", value: "v", attributes: { "a b": "x" } }] }),
    ).toThrow('Invalid attribute name for record_update XML: "a b"');
  });

  it("writes a root table in place of the record's table", () => {
    expect(serializeRecordUpdate({ table: "t", fields: [] }, "[object Object]")).toContain('<record_update table="[object Object]">\n  <t action="INSERT_OR_UPDATE">');
  });

  it("rejects table and field names that are not XML names", () => {
    expect(() => serializeRecordUpdate({ table: "bad table", fields: [] })).toThrow(RecordXmlError);
    expect(() => serializeRecordUpdate({ table: "t", fields: [{ name: "1x", value: "v" }] })).toThrow(
      'Invalid field name for record_update XML: "1x"',
    );
  });
});

describe("serializeDeleteMultiple", () => {
  it("emits a delete_multiple record with an escaped query", () => {
    expect(serializeDeleteMultiple({ table: "sys_ui_section", query: 'name=incident^view="x"&y' })).toBe(
      [
        '<?xml version="1.0"?>',
        '<record_update table="sys_ui_section">',
        '  <sys_ui_section action="delete_multiple" query="name=incident^view=&quot;x&quot;&amp;y"/>',
        "</record_update>",
      ].join("\n"),
    );
    expect(() => serializeDeleteMultiple({ table: "<x>", query: "" })).toThrow(RecordXmlError);
  });
});

describe("serializeCompositeRecordUpdate", () => {
  it("writes every record as a sibling under one record_update", () => {
    const xml = serializeCompositeRecordUpdate("sys_hub_flow", [
      { table: "sys_hub_flow", fields: [{ name: "sys_id", value: "a".repeat(32) }, { name: "name", value: "A & B" }] },
      { table: "sys_hub_action_instance_v2", fields: [{ name: "flow", value: "a".repeat(32) }, { name: "order" }] },
      { table: "sys_hub_flow_input", action: "DELETE", fields: [{ name: "sys_id", value: "b".repeat(32) }] },
    ]);
    expect(xml).toBe(
      [
        '<?xml version="1.0"?>',
        '<record_update table="sys_hub_flow">',
        '  <sys_hub_flow action="INSERT_OR_UPDATE">',
        `    <sys_id>${"a".repeat(32)}</sys_id>`,
        "    <name>A &amp; B</name>",
        "  </sys_hub_flow>",
        '  <sys_hub_action_instance_v2 action="INSERT_OR_UPDATE">',
        `    <flow>${"a".repeat(32)}</flow>`,
        "    <order/>",
        "  </sys_hub_action_instance_v2>",
        '  <sys_hub_flow_input action="DELETE">',
        `    <sys_id>${"b".repeat(32)}</sys_id>`,
        "  </sys_hub_flow_input>",
        "</record_update>",
      ].join("\n"),
    );
  });

  it("matches serializeRecordUpdate for a single record", () => {
    const record = { table: "sys_script", applyDefaults: true, fields: [{ name: "name", value: "x" }] };
    expect(serializeCompositeRecordUpdate("sys_script", [record])).toBe(serializeRecordUpdate(record));
  });

  it("rejects an empty record list and a bad table name", () => {
    expect(() => serializeCompositeRecordUpdate("sys_hub_flow", [])).toThrow(
      "A composite record_update for sys_hub_flow needs at least one record",
    );
    expect(() => serializeCompositeRecordUpdate("bad table", [{ table: "t", fields: [] }])).toThrow(RecordXmlError);
  });

  it("writes a table-less record_update for a null table", () => {
    const xml = serializeCompositeRecordUpdate(null, [
      { table: "sp_portal", fields: [{ name: "icon", value: "a".repeat(32) }] },
      { table: "sys_attachment", fields: [{ name: "sys_id", value: "a".repeat(32) }] },
    ]);
    expect(xml.split("\n").slice(0, 3)).toEqual(['<?xml version="1.0"?>', "<record_update>", '  <sp_portal action="INSERT_OR_UPDATE">']);
    expect(() => serializeCompositeRecordUpdate(null, [])).toThrow("A composite record_update needs at least one record");
  });
});
