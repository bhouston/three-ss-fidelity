import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router';
import Footer from '#/components/Footer';
import Header from '#/components/Header';
import appCss from '../styles.css?url';

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'three-ss-fidelity' },
      {
        name: 'description',
        content: 'three.js screen-space effects (SSGI, SSR, AO) compared against three-gpu-pathtracer ground truth.',
      },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  shellComponent: RootDocument,
  notFoundComponent: () => (
    <>
      <Header />
      <p className="mx-auto max-w-[1120px] px-4 py-8 text-muted-foreground sm:px-6">Not found.</p>
    </>
  ),
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="flex min-h-screen flex-col antialiased">
        <main className="flex-1">{children}</main>
        <Footer />
        <Scripts />
      </body>
    </html>
  );
}
