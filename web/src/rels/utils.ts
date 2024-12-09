import { Agent } from "@atproto/api";
import { DidResolver } from "@atproto/identity";
import { and, eq, lt } from "drizzle-orm";
import { cache } from "react";

import { buildMutex, db } from "@/db";
import { importedDidsT, relsT } from "@/db/schema";
import { Record as _RelRecord } from "@/lexicon/types/my/skylights/rel";
import { getPublicAgent } from "@/utils";

import type { Book } from "./BookCard";

export type RelRecordValue = _RelRecord;
export type RelRecord = {
  uri: string;
  cid: string;
  value: RelRecordValue;
};

export const getDidAgent = cache(async (did: string) => {
  const out = await new DidResolver({}).resolve(did);
  const endpoint = out?.service?.find(
    (s) => s.id == "#atproto_pds",
  )?.serviceEndpoint;
  return new Agent(`${endpoint ?? "https://bsky.social"}/xrpc`);
});

export const importRepo = cache(async (did: string) => {
  await buildMutex(`import-repo-${did}`).withLock(async () => {
    const agent = await getDidAgent(did);

    await db.transaction(async (db) => {
      const recent = new Date();
      recent.setMinutes(recent.getMinutes() - 30);

      const jetskiTime = await db.query.jetskiTimeT.findFirst();
      const isJetksiBehind = !jetskiTime || jetskiTime.time < recent;

      const recentlyImported = await db.query.importedDidsT.findFirst({
        where: (t) =>
          and(
            eq(t.did, did),
            isJetksiBehind ? lt(t.importedAt, recent) : undefined,
          ),
      });

      if (recentlyImported) {
        return;
      }

      await db.delete(relsT).where(eq(relsT.did, did));

      let cursor: string | undefined;
      while (true) {
        const { data } = await agent.com.atproto.repo.listRecords({
          repo: did,
          collection: "my.skylights.rel",
          limit: 100,
          cursor,
        });

        const rows = data.records.map(({ uri, value }) => ({
          did,
          key: uri.split("/").pop()!,
          value,
        }));
        if (!rows.length) {
          break;
        }
        await db
          .insert(relsT)
          .values(rows)
          .onConflictDoUpdate({
            target: [relsT.did, relsT.key],
            set: { value: rows.map((r) => r.value) },
          });

        if (data.records.length < 100) {
          break;
        }
        cursor = data.cursor;
      }

      await db.delete(importedDidsT).where(eq(importedDidsT.did, did));
      await db.insert(importedDidsT).values({ did, importedAt: new Date() });
    });
  });
});

export async function fetchBooks(rels: RelRecordValue[]) {
  const editionKeys = rels
    .map((rel) => rel.item)
    .filter((i) => i.ref == "open-library")
    .map((i) => i.value);
  const response = await fetch(
    "https://ol.index.skylights.my/indexes/open-library/search",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer k-PR1QX-I9D_52oTVAilHF1nOXvGoMHkhZ2mpA3lmg0",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: `edition_key IN ${JSON.stringify(editionKeys)}`,
      }),
    },
  );
  return (await response.json()).hits as Book[];
}

export async function resolveHandle(handle: string) {
  if (!handle.startsWith("did:plc")) {
    const { data } = await getPublicAgent().resolveHandle({ handle });
    return data.did;
  }
  return handle;
}
