"""Generate TTC and Apple resource-container test data from the licensed sfnt fixtures."""
from pathlib import Path
import struct
from fontTools.ttLib import TTCollection, TTFont

root = Path(__file__).parent
collection = TTCollection()
collection.fonts = [TTFont(root / name, recalcTimestamp=False) for name in ('LatinGreek.ttf', 'Devanagari.ttf')]
collection.save(root / 'Faces.ttc')
font = (root / 'LatinGreek.ttf').read_bytes()
data = struct.pack('>I', len(font)) + font
header = struct.pack('>IIII', 256, 256 + len(data), len(data), 50)
# One classic Resource Manager sfnt resource, id 128, without a resource name.
resource_map = header + bytes(8) + struct.pack('>HH', 28, 50)
resource_map += struct.pack('>H4sHH', 0, b'sfnt', 0, 10) + struct.pack('>HHII', 128, 0xffff, 0, 0)
(root / 'Face.dfont').write_bytes(header + bytes(240) + data + resource_map)
