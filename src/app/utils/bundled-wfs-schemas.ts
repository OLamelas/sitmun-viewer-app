/** Resolve only exact, locally bundled standard schemas. Never fetch an alias. */
export async function bundledWfsSchema(url: URL): Promise<{ url: string; xml: string } | undefined> {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
  const gmlPath = url.pathname.match(/(?:^|\/)schemas\/(gml\/[^?#]+\.xsd)$/)?.[1];
  let canonical: string;
  if (gmlPath) canonical = `http://schemas.opengis.net/${gmlPath}`;
  else if (['schemas.opengis.net', 'www.w3.org'].includes(url.hostname) && !url.port) {
    canonical = `http://${url.hostname}${url.pathname}`;
  } else return undefined;
  const { default: schemas } = await import('api-sitna/TC/tool/xsdDocuments.mjs');
  const xml = schemas.get(canonical);
  return xml === undefined ? undefined : { url: canonical, xml };
}
