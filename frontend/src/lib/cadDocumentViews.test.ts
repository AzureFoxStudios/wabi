import { describe, expect, test } from 'bun:test';
import { inspectCadDocumentViews } from './cadDocumentViews';

function dxf(entities: string): string {
  return `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${entities}0\nENDSEC\n0\nEOF\n`;
}

describe('inspectCadDocumentViews', () => {
  test('splits model space from named paper-space layouts', () => {
    const source = dxf(
      `0\nLINE\n8\nMODEL\n10\n0\n20\n0\n11\n10\n21\n0\n` +
      `0\nTEXT\n67\n1\n410\nFloor Plan\n8\nSHEET\n10\n2\n20\n3\n40\n2.5\n1\nFLOOR PLAN\n` +
      `0\nTEXT\n67\n1\n410\nElevations\n8\nSHEET\n10\n5\n20\n6\n40\n2.5\n1\nFRONT\n`
    );

    const document = inspectCadDocumentViews(source);
    expect(document.views.map((view) => [view.kind, view.name])).toEqual([
      ['model', 'Model'],
      ['layout', 'Floor Plan'],
      ['layout', 'Elevations']
    ]);
    expect(document.views[0].text).toContain('MODEL');
    expect(document.views[0].text).not.toContain('FLOOR PLAN');
    expect(document.views[1].text).toContain('FLOOR PLAN');
    expect(document.views[1].text).not.toContain('FRONT');
  });

  test('detects mixed 2D and spatial model-space content without flattening layouts into it', () => {
    const source = dxf(
      `0\nLINE\n8\nMODEL\n10\n0\n20\n0\n30\n0\n11\n10\n21\n0\n31\n0\n` +
      `0\n3DFACE\n8\nMODEL\n10\n0\n20\n0\n30\n0\n11\n10\n21\n0\n31\n0\n12\n10\n22\n10\n32\n5\n13\n0\n23\n10\n33\n5\n` +
      `0\nLINE\n67\n1\n410\nSheet A\n8\nSHEET\n10\n0\n20\n0\n11\n100\n21\n0\n`
    );

    const document = inspectCadDocumentViews(source);
    expect(document.modelDimensionality).toBe('mixed');
    expect(document.hasSpatialModel).toBe(true);
    expect(document.spatialEntityTypes).toContain('3DFACE');
    expect(document.views[0].previewable2d).toBe(true);
    expect(document.views[1].hasSpatialEntities).toBe(false);
  });

  test('recognizes 3D polyline flags and keeps VERTEX/SEQEND with their parent space', () => {
    const source = dxf(
      `0\nPOLYLINE\n8\nMODEL\n70\n8\n66\n1\n` +
      `0\nVERTEX\n8\nMODEL\n10\n0\n20\n0\n30\n0\n` +
      `0\nVERTEX\n8\nMODEL\n10\n1\n20\n1\n30\n2\n` +
      `0\nSEQEND\n8\nMODEL\n` +
      `0\nTEXT\n67\n1\n410\nNotes\n8\nSHEET\n10\n2\n20\n2\n40\n1\n1\nNOTE\n`
    );

    const document = inspectCadDocumentViews(source);
    const model = document.views.find((view) => view.kind === 'model');
    expect(model?.spatialEntityTypes).toContain('POLYLINE_3D');
    expect(model?.text).toContain('VERTEX');
    expect(model?.text).not.toContain('NOTE');
  });

  test('uses a stable fallback name for unnamed paper space', () => {
    const source = dxf(`0\nLINE\n67\n1\n8\nSHEET\n10\n0\n20\n0\n11\n1\n21\n1\n`);
    const document = inspectCadDocumentViews(source);
    expect(document.views).toHaveLength(1);
    expect(document.views[0].kind).toBe('layout');
    expect(document.views[0].name).toBe('Paper Space');
    expect(document.views[0].id).toBe('layout:paper-space');
  });
});
