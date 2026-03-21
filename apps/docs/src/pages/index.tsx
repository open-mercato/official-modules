import React from 'react';
import type { JSX } from 'react';
import Layout from '@theme/Layout';
import Head from '@docusaurus/Head';
import Link from '@docusaurus/Link';

const repositoryGuides = [
  {
    title: 'Overview',
    description: 'Understand what official modules are, what belongs in this repository, and how these docs relate to the main Open Mercato docs.',
    to: '/overview',
  },
  {
    title: 'Using Modules',
    description: 'Install modules with the CLI, choose ownership mode, and verify the critical path before wider rollout.',
    to: '/using-modules',
  },
  {
    title: 'Development Guide',
    description: 'Follow the spec-driven workflow for adding a new official module to this repository.',
    to: '/development-guide',
  },
  {
    title: 'Modules Catalog',
    description: 'Browse the current official module pages instead of reading raw package output.',
    to: '/modules',
  },
];

const coreDocsLinks = [
  {
    title: 'Framework Modules',
    description: 'Open the canonical Open Mercato module-system docs when you need extension-point details.',
    to: 'https://docs.openmercato.com/framework/modules/overview',
  },
  {
    title: 'Standalone App Guide',
    description: 'Use the main docs for broader platform setup and standalone app bootstrapping.',
    to: 'https://docs.openmercato.com/customization/standalone-app',
  },
  {
    title: 'CLI Reference',
    description: 'Check the main CLI documentation for commands beyond the scope of this repository-specific guide.',
    to: 'https://docs.openmercato.com/cli/overview',
  },
  {
    title: 'GitHub Repository',
    description: 'Open the official-modules repository for code, specs, releases, and pull request workflow.',
    to: 'https://github.com/open-mercato/official-modules',
  },
];

function HomepageHeader() {
  return (
    <header className="hero hero--primary">
      <div className="container">
        <h1 className="hero__title">Official Modules Documentation</h1>
        <p className="hero__subtitle">
          Repository docs for installing, operating, and building official Open Mercato modules.
        </p>
        <p>
          This docs app stays focused on the `official-modules` repository: what it ships, how to use modules in a real app,
          and how to contribute new ones without drifting away from the core platform workflow.
        </p>
        <div>
          <Link className="button button--lg button--secondary" to="/modules">
            Explore Modules
          </Link>
          <Link className="button button--lg button--outline button--white margin-left--sm" to="/using-modules">
            Using Modules
          </Link>
        </div>
      </div>
    </header>
  );
}

function RepositoryGuides() {
  return (
    <section className="margin-top--xl">
      <div className="container">
        <h2>Repository Guides</h2>
        <div className="feature-grid">
          {repositoryGuides.map((guide) => (
            <Link key={guide.title} className="feature-card" to={guide.to}>
              <h3>{guide.title}</h3>
              <p>{guide.description}</p>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

function CoreDocs() {
  return (
    <section className="margin-vert--xl">
      <div className="container">
        <h2>Related Resources</h2>
        <p>Framework theory and broader platform setup still live in the main Open Mercato docs.</p>
        <div className="feature-grid">
          {coreDocsLinks.map((link) => (
            <Link key={link.title} className="feature-card" to={link.to}>
              <h3>{link.title}</h3>
              <p>{link.description}</p>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

export default function Home(): JSX.Element {
  return (
    <Layout>
      <Head>
        <meta
          name="description"
          content="Documentation for the official Open Mercato modules repository covering overview, module usage, development workflow, and module catalog pages."
        />
      </Head>
      <HomepageHeader />
      <main>
        <RepositoryGuides />
        <CoreDocs />
      </main>
    </Layout>
  );
}
