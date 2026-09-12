"""Test fixture metadata normalization without requiring Office writer packages."""
import ast
from pathlib import Path
from io import BytesIO
import unittest
from xml.etree import ElementTree
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
from tempfile import TemporaryDirectory

class FixturePrivacy(unittest.TestCase):
 def test_clears_modifier_preserving_document_content(self):
  source=Path(__file__).parents[1]/'benchmarks/fixtures.py'
  tree=ast.parse(source.read_text(encoding='utf-8'))
  function=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='deterministic_package')
  namespace={name:globals()[name] for name in ('BytesIO','ZipFile','ZipInfo','ZIP_DEFLATED','ElementTree')}
  exec(compile(ast.Module(body=[function],type_ignores=[]),str(source),'exec'),namespace)
  with TemporaryDirectory() as directory:
   path=Path(directory)/'fixture.pptx'
   with ZipFile(path,'w') as archive:
    archive.writestr('docProps/core.xml','<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dcterms="http://purl.org/dc/terms/"><cp:lastModifiedBy>Fixture Writer</cp:lastModifiedBy><dcterms:modified>2026-01-01T00:00:00Z</dcterms:modified></cp:coreProperties>')
    archive.writestr('ppt/slides/slide1.xml','<slide>Synthetic content</slide>')
   namespace['deterministic_package'](path)
   with ZipFile(path) as archive:
    properties=ElementTree.fromstring(archive.read('docProps/core.xml'))
    self.assertIsNone(properties.find('{http://schemas.openxmlformats.org/package/2006/metadata/core-properties}lastModifiedBy').text)
    self.assertEqual(properties.find('{http://purl.org/dc/terms/}modified').text,'2000-01-01T00:00:00Z')
    self.assertEqual(archive.read('ppt/slides/slide1.xml'),b'<slide>Synthetic content</slide>')
    self.assertTrue(all(info.date_time==(1980,1,1,0,0,0) for info in archive.infolist()))

if __name__=='__main__': unittest.main()
