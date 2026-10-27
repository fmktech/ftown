import manifest from "../../public/product/manifest.json";

type Capture = (typeof manifest.images)["desktop"];

const imageClass = "block w-full h-auto rounded-[var(--radius-md)] border border-[var(--border-muted)] bg-[var(--bg-elevated)]";
const captionClass = "font-[family-name:var(--font-sans)] text-[13px] leading-relaxed text-[var(--text-secondary)]";
const linkClass = "inline-flex min-h-11 items-center rounded-[var(--radius-sm)] text-[13px] text-[var(--accent)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]";

function sources(capture: Capture) {
  return capture.variants.map((variant) => `${variant.src} ${variant.width}w`).join(", ");
}

function Walkthrough({ kind, poster }: { kind: "desktop" | "mobile"; poster: string }) {
  const video = manifest.videos[kind];
  const label = kind === "desktop" ? "desktop" : "mobile";
  return (
    <details className="mt-2 min-w-0">
      <summary className={`${linkClass} cursor-pointer gap-2`}><span aria-hidden="true">▸</span>Watch {label} walkthrough</summary>
      <p className={`${captionClass} mb-3`}>Recorded in the same isolated demo workspace.</p>
      <video
        aria-label={`FTown ${label} walkthrough`}
        controls
        playsInline
        preload="none"
        poster={poster}
        src={video.src}
        width={video.width}
        height={video.height}
        className={`${imageClass} ${kind === "mobile" ? "mx-auto max-w-[280px]" : ""}`}
      />
    </details>
  );
}

export function DesktopScreenshot() {
  const capture = manifest.images.desktop;
  return (
    <div className="mt-8">
      <figure>
        {/* Real, pre-sized captures are served directly so the original image remains available. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={capture.src}
          srcSet={sources(capture)}
          sizes="(min-width: 1168px) 1120px, (min-width: 640px) calc(100vw - 48px), calc(100vw - 32px)"
          width={capture.width}
          height={capture.height}
          alt="FTown desktop dashboard with a session sidebar and an open shell terminal."
          loading="eager"
          fetchPriority="high"
          className={imageClass}
        />
        <figcaption className="mt-3">
          <p className={captionClass}>A real FTown workspace: sessions on the left, a live terminal on the right.</p>
          <p className={`${captionClass} mt-1`}>Captured from a real, isolated FTown demo workspace.</p>
          <a className={linkClass} href={capture.src}>Open desktop screenshot</a>
        </figcaption>
      </figure>
      <Walkthrough kind="desktop" poster={capture.src} />
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
            <p className={captionClass}>Open the same session from a phone-sized browser, with controls made for touch.</p>
          </figcaption>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={mobile.src}
            srcSet={sources(mobile)}
            sizes="(min-width: 346px) 280px, calc(100vw - 66px)"
            width={mobile.width}
            height={mobile.height}
            alt="FTown mobile terminal with Workspace and Terminal navigation and touch controls."
            loading="lazy"
            className={`${imageClass} mx-auto max-w-[280px]`}
          />
          <a className={`${linkClass} mt-2`} href={mobile.src}>Open mobile screenshot</a>
          <Walkthrough kind="mobile" poster={mobile.src} />
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
          <a className={`${linkClass} mt-2`} href={security.src}>Open security screenshot</a>
        </figure>
      </div>
    </section>
  );
}
