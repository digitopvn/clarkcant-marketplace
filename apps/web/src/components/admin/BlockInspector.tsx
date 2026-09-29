import { useId, type ReactNode } from "react";

import type { BlockDescription, BlockNode, EditorField } from "./builder-types";

/*
 * Inspector controls generated from a block's `editor.fields`. The inspector never knows about specific blocks: a
 * new block gets a working inspector by declaring its fields. Values are written back as a whole props object; the
 * server re-validates them against the block's schema.
 */

const inputClass =
  "w-full rounded-lg border border-line bg-card px-2.5 py-1.5 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none";
const smallButton = "rounded-full border border-line px-2 py-0.5 text-xs text-muted hover:border-accent hover:text-ink disabled:opacity-40";

const REFERENCE_HINTS: Record<string, string> = {
  media: "Media id (med_…)",
  package: "npm package name, e.g. @acme/chart-widget",
  collection: "Collection slug",
  publisher: "Publisher slug",
  category: "Category slug",
};

type Values = Record<string, unknown>;

/** A blank value for a field, used when adding list items or enabling an optional group. */
function emptyValue(field: EditorField): unknown {
  switch (field.kind) {
    case "number":
      return field.min ?? 0;
    case "boolean":
      return false;
    case "select":
      return field.options[0]?.value ?? "";
    case "group":
      return Object.fromEntries(field.fields.map((inner) => [inner.name, emptyValue(inner)]));
    case "list":
      return [];
    default:
      return "";
  }
}

function asRecord(value: unknown): Values {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Values) : {};
}

function FieldFrame({ id, label, help, children }: { id: string; label: string; help?: string | undefined; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted">
        {label}
      </label>
      {children}
      {help && (
        <p id={`${id}-help`} className="text-xs text-faint">
          {help}
        </p>
      )}
    </div>
  );
}

function FieldControl({ field, value, onChange }: { field: EditorField; value: unknown; onChange: (next: unknown) => void }) {
  const id = useId();
  const describedBy = field.help ? `${id}-help` : undefined;
  switch (field.kind) {
    case "text":
    case "url":
    case "reference":
      return (
        <FieldFrame id={id} label={field.label} help={field.help ?? (field.kind === "reference" ? REFERENCE_HINTS[field.target] : undefined)}>
          <input
            id={id}
            className={`${inputClass} ${field.kind === "reference" ? "font-mono" : ""}`}
            type="text"
            inputMode={field.kind === "url" ? "url" : undefined}
            value={typeof value === "string" ? value : ""}
            maxLength={field.kind === "text" || field.kind === "url" ? field.maxLength : undefined}
            aria-describedby={describedBy}
            onChange={(event) => onChange(event.target.value)}
          />
        </FieldFrame>
      );
    case "textarea":
    case "markdown":
      return (
        <FieldFrame id={id} label={field.label} help={field.help ?? (field.kind === "markdown" ? "Markdown. Raw HTML is removed." : undefined)}>
          <textarea
            id={id}
            className={`${inputClass} min-h-28 ${field.kind === "markdown" ? "font-mono" : ""}`}
            value={typeof value === "string" ? value : ""}
            maxLength={field.maxLength}
            aria-describedby={describedBy}
            onChange={(event) => onChange(event.target.value)}
          />
        </FieldFrame>
      );
    case "number":
      return (
        <FieldFrame id={id} label={field.label} help={field.help}>
          <input
            id={id}
            className={inputClass}
            type="number"
            min={field.min}
            max={field.max}
            value={typeof value === "number" ? value : ""}
            aria-describedby={describedBy}
            onChange={(event) => onChange(event.target.value === "" ? (field.min ?? 0) : Number(event.target.value))}
          />
        </FieldFrame>
      );
    case "boolean":
      return (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />
          {field.label}
        </label>
      );
    case "select":
      return (
        <FieldFrame id={id} label={field.label} help={field.help}>
          <select id={id} className={inputClass} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)}>
            {field.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </FieldFrame>
      );
    case "group": {
      const present = value !== undefined && value !== null;
      return (
        <fieldset className="grid gap-2 rounded-lg border border-line p-2.5">
          <legend className="px-1 text-xs font-medium text-muted">{field.label}</legend>
          {field.optional && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={present} onChange={(event) => onChange(event.target.checked ? emptyValue(field) : undefined)} />
              Include {field.label.toLowerCase()}
            </label>
          )}
          {(present || !field.optional) && <FieldList fields={field.fields} values={asRecord(value)} onChange={onChange} />}
        </fieldset>
      );
    }
    case "list":
      return <ListControl field={field} value={value} onChange={onChange} />;
  }
}

function ListControl({ field, value, onChange }: { field: Extract<EditorField, { kind: "list" }>; value: unknown; onChange: (next: unknown) => void }) {
  const items = Array.isArray(value) ? value : [];
  const plain = field.fields.length === 1 && field.fields[0]?.name === "";
  const itemField = field.fields[0];
  const set = (next: unknown[]) => onChange(next);
  const move = (from: number, to: number) => {
    const next = [...items];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    set(next);
  };
  const canAdd = field.maxItems === undefined || items.length < field.maxItems;
  const canRemove = items.length > (field.minItems ?? 0);
  const blank = plain && itemField ? emptyValue(itemField) : Object.fromEntries(field.fields.map((inner) => [inner.name, emptyValue(inner)]));

  return (
    <fieldset className="grid gap-2 rounded-lg border border-line p-2.5">
      <legend className="px-1 text-xs font-medium text-muted">{field.label}</legend>
      {field.help && <p className="text-xs text-faint">{field.help}</p>}
      {items.map((item, index) => (
        <div key={index} className="grid gap-2 rounded-lg bg-raised p-2" role="group" aria-label={`${field.itemLabel} ${index + 1}`}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted">
              {field.itemLabel} {index + 1}
            </span>
            <span className="flex gap-1">
              <button type="button" className={smallButton} disabled={index === 0} onClick={() => move(index, index - 1)} aria-label={`Move ${field.itemLabel} ${index + 1} up`}>
                Up
              </button>
              <button
                type="button"
                className={smallButton}
                disabled={index === items.length - 1}
                onClick={() => move(index, index + 1)}
                aria-label={`Move ${field.itemLabel} ${index + 1} down`}
              >
                Down
              </button>
              <button
                type="button"
                className={smallButton}
                disabled={!canRemove}
                onClick={() => set(items.filter((_, other) => other !== index))}
                aria-label={`Remove ${field.itemLabel} ${index + 1}`}
              >
                Remove
              </button>
            </span>
          </div>
          {plain && itemField ? (
            <FieldControl field={{ ...itemField, label: `${field.itemLabel} ${index + 1}` } as EditorField} value={item} onChange={(next) => set(items.map((old, other) => (other === index ? next : old)))} />
          ) : (
            <FieldList fields={field.fields} values={asRecord(item)} onChange={(next) => set(items.map((old, other) => (other === index ? next : old)))} />
          )}
        </div>
      ))}
      <button type="button" className={`${smallButton} justify-self-start`} disabled={!canAdd} onClick={() => set([...items, structuredClone(blank)])}>
        Add {field.itemLabel.toLowerCase()}
      </button>
    </fieldset>
  );
}

function FieldList({ fields, values, onChange }: { fields: EditorField[]; values: Values; onChange: (next: Values) => void }) {
  return (
    <div className="grid gap-3">
      {fields.map((field) => (
        <FieldControl
          key={field.name}
          field={field}
          value={values[field.name]}
          onChange={(next) => {
            const updated = { ...values };
            if (next === undefined) delete updated[field.name];
            else updated[field.name] = next;
            onChange(updated);
          }}
        />
      ))}
    </div>
  );
}

export function BlockInspector({
  node,
  description,
  issues,
  onChange,
}: {
  node: BlockNode;
  description: BlockDescription | undefined;
  issues: string[];
  onChange: (props: Record<string, unknown>) => void;
}) {
  if (!description) {
    return <p className="text-sm text-warning">Unknown block type “{node.type}”. Remove it or change the layout.</p>;
  }
  return (
    <div className="grid gap-3">
      <div>
        <h3 className="font-display text-xl">{description.label}</h3>
        <p className="text-xs text-muted">{description.description}</p>
      </div>
      {issues.length > 0 && (
        <ul className="grid gap-1 rounded-lg border border-dashed border-warning p-2 text-xs text-warning" aria-label="Problems with this block">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      {description.fields.length === 0 ? (
        <p className="text-sm text-muted">This block has no settings.</p>
      ) : (
        <FieldList fields={description.fields} values={node.props} onChange={onChange} />
      )}
    </div>
  );
}
