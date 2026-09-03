import { Suspense } from "react";
import { DocumentsClient } from "./DocumentsClient";

export default function DocumentsPage() {
  return (
    <Suspense>
      <DocumentsClient />
    </Suspense>
  );
}
