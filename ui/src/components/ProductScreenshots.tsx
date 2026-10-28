import manifest from "../../public/product/manifest.json";
import { ProductWalkthrough } from "./ProductWalkthrough";

type Capture = (typeof manifest.images)["desktop"];

const imageClass = "block w-full h-auto rounded-[var(--radius-md)] border border-[var(--border-muted)] bg-[var(--bg-elevated)]";
const captionClass = "font-[family-name:var(--font-sans)] text-[13px] leading-relaxed text-[var(--text-secondary)]";

function sources(capture: Capture) {
  return capture.variants.map((variant) => `${variant.src} ${variant.width}w`).join(", ");
}

export function DesktopScreenshot() {
  const capture = manifest.images.desktop;
  return (
    <div className="mt-8">
      <figure>
        <ProductWalkthrough
          kind="desktop"
          image={capture}
          video={manifest.videos.desktop}
          alt="FTown desktop showing Codex receiving replies from its Claude Code and Pi sessions."
          sizes="(min-width: 1168px) 1120px, (min-width: 640px) calc(100vw - 48px), calc(100vw - 32px)"
          loading="eager"
          fetchPriority="high"
        />
        <figcaption className="mt-3">
          <p className={captionClass}>Codex opens Claude Code and Pi, delegates two checks and reads their replies. Waiting time omitted.</p>
        </figcaption>
      </figure>
    </div>
  );
}

export function SupportingScreenshots() {
  const mobile = manifest.images.mobile;
  const security = manifest.images.security;
  return (
    <section aria-labelledby="workspace-evidence-heading" className="mt-12 sm:mt-16 w-full max-w-[1120px]">
      <h2 id="workspace-evidence-heading" className="font-[family-name:var(--font-sans)] text-[clamp(24px,4vw,36px)] font-bold tracking-[-0.02em] text-[var(--text-primary)] mb-6">
        Your workspace, wherever you are.
      </h2>
      <div className="grid gap-6 min-[900px]:grid-cols-[360px_minmax(0,1fr)] items-start">
        <figure className="min-w-0 rounded-[var(--radius-lg)] border border-[var(--border-muted)] bg-[var(--bg-surface)] p-4 sm:p-6">
          <figcaption className="mb-4">
            <h3 className="font-[family-name:var(--font-sans)] text-lg font-bold text-[var(--text-primary)] mb-2">Pick up from your phone.</h3>
            <p className={captionClass}>Follow the same agents and their replies from your phone.</p>
          </figcaption>
          <ProductWalkthrough
            kind="mobile"
            image={mobile}
            video={manifest.videos.mobile}
            alt="FTown on a phone-sized screen showing Codex's summary of replies from Claude Code and Pi, with touch controls."
            sizes="(min-width: 346px) 280px, calc(100vw - 66px)"
            loading="lazy"
          />
        </figure>
        <figure className="min-w-0 rounded-[var(--radius-lg)] border border-[var(--border-muted)] bg-[var(--bg-surface)] p-4 sm:p-6">
          <figcaption className="mb-4">
            <h3 className="font-[family-name:var(--font-sans)] text-lg font-bold text-[var(--text-primary)] mb-2">See which devices have access.</h3>
            <p className={captionClass}>Review the browsers and computers connected to your account from the Security panel.</p>
          </figcaption>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={security.src}
            srcSet={sources(security)}
            sizes="(min-width: 1168px) 686px, (min-width: 900px) calc(100vw - 482px), (min-width: 640px) calc(100vw - 98px), calc(100vw - 66px)"
            width={security.width}
            height={security.height}
            alt="FTown Security Access panel showing approved browsers and verified computer access."
            loading="lazy"
            className={imageClass}
          />
        </figure>
      </div>
    </section>
  );
}
