import { Link } from '@tanstack/react-router';
import { Github } from 'lucide-react';

export const SITE_NAME = 'Screen-Space Fidelity';

export default function Header({ children }: { children?: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-card/95 py-3 shadow-sm backdrop-blur">
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-2 px-4 sm:px-6 md:flex-row md:items-center">
        <Link className="text-base font-semibold text-foreground no-underline sm:text-xl" to="/">
          {SITE_NAME}
        </Link>
        <div className="flex items-center gap-2 md:ml-auto">
          {children}
          <a
            aria-label="ss-fidelity repository"
            className="ml-1 inline-flex items-center text-muted-foreground transition-colors hover:text-foreground"
            href="https://github.com/bhouston/ss-fidelity"
            rel="noopener noreferrer"
            target="_blank"
          >
            <Github className="size-4" />
          </a>
        </div>
      </div>
    </header>
  );
}

export const buttonClassName =
  'inline-flex items-center gap-1 rounded-none border border-border bg-muted/40 px-2.5 py-1.5 text-sm font-normal text-foreground transition-colors hover:border-primary/40 hover:bg-muted/60';
