import { Link, useSearch } from '@tanstack/react-router';
import { Github } from 'lucide-react';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '#/components/ui/breadcrumb';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#/components/ui/select';
import { PASSES, parsePass, passSearch, type PassName } from '#/lib/scenes';

export const SITE_NAME = 'Three SS Fidelity';

/** Top nav: a breadcrumb (home › scene › live renderer) that carries the current pass, page controls, and GitHub. */
export default function Header({
  scene,
  renderer,
  children,
}: {
  scene?: string;
  renderer?: string;
  children?: React.ReactNode;
}) {
  const search = { pass: passSearch(parsePass(useSearch({ strict: false }).pass)) };
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-card/95 py-3 shadow-sm backdrop-blur">
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-2 px-4 sm:px-6 md:flex-row md:items-center">
        <Breadcrumb>
          <BreadcrumbList className="text-base sm:text-lg">
            <BreadcrumbItem>
              {scene ? (
                <BreadcrumbLink asChild>
                  <Link search={search} to="/">
                    {SITE_NAME}
                  </Link>
                </BreadcrumbLink>
              ) : (
                <BreadcrumbPage className="font-semibold">{SITE_NAME}</BreadcrumbPage>
              )}
            </BreadcrumbItem>
            {scene ? (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  {renderer ? (
                    <BreadcrumbLink asChild>
                      <Link params={{ name: scene }} search={search} to="/scenes/$name">
                        {scene}
                      </Link>
                    </BreadcrumbLink>
                  ) : (
                    <BreadcrumbPage>{scene}</BreadcrumbPage>
                  )}
                </BreadcrumbItem>
              </>
            ) : null}
            {scene && renderer ? (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage>{renderer}</BreadcrumbPage>
                </BreadcrumbItem>
              </>
            ) : null}
          </BreadcrumbList>
        </Breadcrumb>
        <div className="flex items-center gap-2 md:ml-auto">
          {children}
          <a
            aria-label="three-ss-fidelity repository"
            className="ml-1 inline-flex items-center text-muted-foreground transition-colors hover:text-foreground"
            href="https://github.com/bhouston/three-ss-fidelity"
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

/** The beauty/direct/ao dropdown; each page writes the `pass` search param with its own typed navigate. */
export function PassSelect({ value, onValueChange }: { value: PassName; onValueChange: (pass: PassName) => void }) {
  return (
    <Select onValueChange={(pass) => onValueChange(parsePass(pass))} value={value}>
      <SelectTrigger aria-label="Pass" className="shrink-0" title="Pass">
        {/* explicit children: Radix only fills the value on the client, leaving SSR blank */}
        <SelectValue>{value}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {PASSES.map((pass) => (
          <SelectItem key={pass} value={pass}>
            {pass}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
