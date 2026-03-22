import React from 'react';
import type { JSX } from 'react';
import Layout from '@theme/Layout';
import Head from '@docusaurus/Head';
import Link from '@docusaurus/Link';

const repositoryGuides = [
  {
    title: 'Overview',
    description: 'What official modules are and why they exist.',
    to: '/overview',
  },
  {
    title: 'Using Modules',
    description: 'Install, eject, upgrade, and verify modules.',
    to: '/using-modules',
  },
  {
    title: 'Development Guide',
    description: 'Add a new official module with the spec-driven workflow.',
    to: '/development-guide',
  },
  {
    title: 'Modules Catalog',
    description: 'Browse available modules and open their setup guides.',
    to: '/modules',
  },
];

const coreDocsLinks = [
  {
    title: 'Framework Modules',
    description: 'Extension points and module-system concepts.',
    to: 'https://docs.openmercato.com/framework/modules/overview',
  },
  {
    title: 'Standalone App Guide',
    description: 'Standalone app setup and bootstrapping.',
    to: 'https://docs.openmercato.com/customization/standalone-app',
  },
  {
    title: 'CLI Reference',
    description: 'CLI commands outside this repository guide.',
    to: 'https://docs.openmercato.com/cli/overview',
  },
  {
    title: 'GitHub Repository',
    description: 'Source code, specs, releases, and pull requests.',
    to: 'https://github.com/open-mercato/official-modules',
  },
];

function HomepageHeader() {
  return (
    <header className="hero hero--primary">
      <div className="container">
      <h1 className="hero__title">Official Open Mercato Modules</h1>
      <p className="hero__subtitle">
        Official modules are installable Open Mercato packages for optional capabilities like payments, shipping, integrations, and business workflows.
        </p>
        <p>
        This repository exists to keep core focused while growing the ecosystem through stable extension points.
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
        <h2>Start Here</h2>
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
        <p>Use the main docs for framework details and full platform setup.</p>
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
