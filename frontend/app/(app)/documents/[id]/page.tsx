"use client";

import { use } from "react";
import { DocumentEditor } from "./DocumentEditor";

export default function DocumentEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <DocumentEditor documentId={id} />;
}
