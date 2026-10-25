import { setupNetwork } from "@msw/cloudflare";
import { http, HttpResponse } from "msw";

export const network = setupNetwork();
export function mockSfu() {
  let sequence = 0;
  const sessions = new Map<string, string[]>();
  const closed: string[] = [];
  network.use(
    http.post(
      "https://rtc.live.cloudflare.com/v1/apps/test-app/sessions/new",
      ({ request }) => {
        if (request.headers.get("Authorization") !== "Bearer test-secret")
          throw new Error("Wrong provider credential");
        const id = `s-${++sequence}`;
        sessions.set(id, []);
        return HttpResponse.json({ sessionId: id });
      },
    ),
    http.post(
      "https://rtc.live.cloudflare.com/v1/apps/test-app/sessions/:id/tracks/new",
      async ({ request, params }) => {
        const input = (await request.json()) as {
          tracks: { location: string; mid?: string; trackName: string }[];
        };
        const remote = input.tracks[0]?.location === "remote";
        const tracks = input.tracks.map((t, i) => ({
          mid: remote ? `${i}` : t.mid!,
          trackName: t.trackName,
        }));
        sessions.set(
          String(params.id),
          tracks.map((t) => t.mid),
        );
        return HttpResponse.json({
          sessionDescription: {
            type: remote ? "offer" : "answer",
            sdp: "mock-sdp",
          },
          requiresImmediateRenegotiation: remote,
          tracks,
        });
      },
    ),
    http.put(
      "https://rtc.live.cloudflare.com/v1/apps/test-app/sessions/:id/renegotiate",
      () => HttpResponse.json({}),
    ),
    http.get(
      "https://rtc.live.cloudflare.com/v1/apps/test-app/sessions/:id",
      ({ params }) =>
        HttpResponse.json({
          tracks: (sessions.get(String(params.id)) ?? []).map((mid) => ({
            mid,
          })),
        }),
    ),
    http.put(
      "https://rtc.live.cloudflare.com/v1/apps/test-app/sessions/:id/tracks/close",
      async ({ request, params }) => {
        const input = (await request.json()) as {
          tracks: { mid: string }[];
          force: boolean;
        };
        if (input.force !== true)
          throw new Error("Cleanup must close forwarding without browser SDP");
        closed.push(String(params.id));
        sessions.set(String(params.id), []);
        return HttpResponse.json({
          tracks: input.tracks.map((t) => ({ mid: t.mid })),
        });
      },
    ),
  );
  return { sessions, closed };
}
