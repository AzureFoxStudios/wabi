import assert from 'node:assert/strict';
import PptxGenJS from 'pptxgenjs';
import JSZip from 'jszip';

export async function compatibilityFixtures() {
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE';
    const visible = pptx.addSlide();
    visible.addText('PUBLIC_COMPATIBILITY_SLIDE', { x: 1, y: 1, w: 10, h: 1, fontSize: 26 });
    visible.addNotes('PRIVATE_COMPATIBILITY_NOTES');
    const hidden = pptx.addSlide();
    hidden.addText('PRIVATE_HIDDEN_COMPATIBILITY_SLIDE', { x: 1, y: 1, w: 10, h: 1 });
    const source = await pptx.write({ outputType: 'nodebuffer' });
    const archive = await JSZip.loadAsync(source);
    const slide = await archive.file('ppt/slides/slide2.xml').async('string');
    assert(slide.includes('<p:sld '), 'Fixture must mark a real PowerPoint slide as hidden');
    archive.file('ppt/slides/slide2.xml', slide.replace('<p:sld ', '<p:sld show="0" '));
    const powerPoint = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

    const odp = new JSZip();
    odp.file('mimetype', 'application/vnd.oasis.opendocument.presentation', { compression: 'STORE' });
    odp.file('META-INF/manifest.xml', `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.presentation"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`);
    odp.file('styles.xml', `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.2">
<office:styles/><office:automatic-styles><style:page-layout style:name="PM1"><style:page-layout-properties fo:page-width="28cm" fo:page-height="15.75cm" style:print-orientation="landscape"/></style:page-layout></office:automatic-styles>
<office:master-styles><style:master-page style:name="Default" style:page-layout-name="PM1"/></office:master-styles></office:document-styles>`);
    odp.file('content.xml', `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.2">
<office:automatic-styles/><office:body><office:presentation><draw:page draw:name="Slide1" draw:master-page-name="Default">
<draw:frame draw:layer="layout" svg:x="2cm" svg:y="2cm" svg:width="24cm" svg:height="4cm" presentation:class="title"><draw:text-box><text:p>PUBLIC_ODP_COMPATIBILITY_SLIDE</text:p></draw:text-box></draw:frame>
</draw:page></office:presentation></office:body></office:document-content>`);
    return [
        { name: 'compatibility.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer: powerPoint, expected: 'PUBLIC_COMPATIBILITY_SLIDE' },
        { name: 'compatibility.odp', mimeType: 'application/vnd.oasis.opendocument.presentation', buffer: await odp.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), expected: 'PUBLIC_ODP_COMPATIBILITY_SLIDE' }
    ];
}
