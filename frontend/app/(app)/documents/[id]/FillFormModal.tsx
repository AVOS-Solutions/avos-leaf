"use client";

import { useEffect, useState } from "react";
import type { PDFDocument } from "pdf-lib";
import { PDFCheckBox, PDFDropdown, PDFOptionList, PDFRadioGroup, PDFTextField } from "pdf-lib";
import { Button, Input, Label, Select } from "@/components/ui";

type FieldRow =
  | { kind: "text"; name: string; value: string }
  | { kind: "check"; name: string; checked: boolean }
  | { kind: "choice"; name: string; options: string[]; value: string };

/** Lists every AcroForm field this PDF already has (from being created in Acrobat, DocuSign,
 *  government e-forms, etc.) and lets the account fill them in — pdf-lib reads/writes the form's
 *  existing field objects directly, it doesn't add new ones. "Flatten" bakes the entered values
 *  into the page content and removes the underlying form fields, matching what most people expect
 *  "filled in" to mean (the values become permanent, uneditable text) rather than leaving another
 *  PDF viewer able to change them again. */
export function FillFormModal({
  open,
  onClose,
  pdfDoc,
  onApplied,
}: {
  open: boolean;
  onClose: () => void;
  pdfDoc: PDFDocument | null;
  onApplied: () => void;
}) {
  const [rows, setRows] = useState<FieldRow[]>([]);
  const [flatten, setFlatten] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !pdfDoc) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- re-reading the form's current field values whenever the modal opens on a (possibly different) document, not reacting to external state
    setError(null);
    try {
      const form = pdfDoc.getForm();
      const fields = form.getFields();
      const next: FieldRow[] = fields.map((field) => {
        const name = field.getName();
        if (field instanceof PDFTextField) return { kind: "text", name, value: field.getText() ?? "" };
        if (field instanceof PDFCheckBox) return { kind: "check", name, checked: field.isChecked() };
        if (field instanceof PDFDropdown) return { kind: "choice", name, options: field.getOptions(), value: field.getSelected()[0] ?? "" };
        if (field instanceof PDFRadioGroup) return { kind: "choice", name, options: field.getOptions(), value: field.getSelected() ?? "" };
        if (field instanceof PDFOptionList) return { kind: "choice", name, options: field.getOptions(), value: field.getSelected()[0] ?? "" };
        return { kind: "text", name, value: "" };
      });
      setRows(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read this document's form fields.");
      setRows([]);
    }
  }, [open, pdfDoc]);

  function updateRow(index: number, patch: Partial<FieldRow>) {
    setRows((prev) => prev.map((row, i) => (i === index ? ({ ...row, ...patch } as FieldRow) : row)));
  }

  async function apply() {
    if (!pdfDoc) return;
    setApplying(true);
    setError(null);
    try {
      const form = pdfDoc.getForm();
      for (const row of rows) {
        const field = form.getField(row.name);
        if (row.kind === "text" && field instanceof PDFTextField) field.setText(row.value);
        else if (row.kind === "check" && field instanceof PDFCheckBox) {
          if (row.checked) field.check();
          else field.uncheck();
        } else if (row.kind === "choice" && (field instanceof PDFDropdown || field instanceof PDFRadioGroup || field instanceof PDFOptionList)) {
          if (row.value) field.select(row.value);
        }
      }
      if (flatten) form.flatten();
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save these form values.");
    } finally {
      setApplying(false);
    }
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-lg overflow-auto rounded-lg border border-line bg-white p-5 shadow-sm" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg">Fill form</h2>
          <button className="mono text-xs text-slate hover:text-ink" onClick={onClose} aria-label="Close">
            close
          </button>
        </div>
        {error && <p className="mb-3 text-sm text-brass">{error}</p>}

        {rows.length === 0 && !error ? (
          <p className="text-sm text-slate">This PDF has no fillable form fields.</p>
        ) : (
          <div className="space-y-4">
            {rows.map((row, index) => (
              <div key={row.name}>
                <Label>{row.name}</Label>
                {row.kind === "text" && (
                  <Input value={row.value} onChange={(e) => updateRow(index, { value: e.target.value })} />
                )}
                {row.kind === "check" && (
                  <label className="flex items-center gap-2 text-sm text-ink">
                    <input type="checkbox" checked={row.checked} onChange={(e) => updateRow(index, { checked: e.target.checked })} />
                    Checked
                  </label>
                )}
                {row.kind === "choice" && (
                  <Select value={row.value} onChange={(e) => updateRow(index, { value: e.target.value })}>
                    <option value="">—</option>
                    {row.options.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </Select>
                )}
              </div>
            ))}
          </div>
        )}

        <label className="mt-5 flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={flatten} onChange={(e) => setFlatten(e.target.checked)} />
          Flatten form when saving (makes the entered values permanent, uneditable)
        </label>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={applying || rows.length === 0}>
            {applying ? "Saving…" : "Apply"}
          </Button>
        </div>
      </div>
    </div>
  );
}
