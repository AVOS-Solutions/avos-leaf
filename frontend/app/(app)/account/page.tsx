import { getCurrentUser } from "@/lib/session";
import { LICENSING_PUBLIC_URL } from "@/lib/config";
import { Card, PageHeader, Button } from "@/components/ui";

export default async function AccountPage() {
  const user = await getCurrentUser();

  return (
    <>
      <PageHeader eyebrow="Account" title="Your account" />
      <Card className="max-w-lg">
        <dl className="space-y-4 text-sm">
          <div>
            <dt className="eyebrow mb-1">Name</dt>
            <dd>{user?.fullName}</dd>
          </div>
          <div>
            <dt className="eyebrow mb-1">Email</dt>
            <dd>{user?.email}</dd>
          </div>
        </dl>
        <div className="mt-6 border-t border-line pt-6">
          <p className="mb-3 text-sm text-ink-soft">
            Your avos-leaf license, billing, and other AVOS product access are all managed from your
            AVOS account.
          </p>
          <a href={LICENSING_PUBLIC_URL}>
            <Button type="button" variant="secondary">
              Manage licenses
            </Button>
          </a>
        </div>
      </Card>
    </>
  );
}
