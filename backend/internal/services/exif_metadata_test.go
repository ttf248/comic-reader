package services

import (
	"bytes"
	"encoding/binary"
	"math"
	"testing"
)

func TestParseImageMetadataReadsEXIFAndGPS(t *testing.T) {
	metadata, err := ParseImageMetadata(bytes.NewReader(testExifJPEG()))
	if err != nil {
		t.Fatalf("ParseImageMetadata() error = %v", err)
	}
	if metadata.Status != MetadataParseParsed {
		t.Fatalf("status = %q, want %q", metadata.Status, MetadataParseParsed)
	}
	if metadata.DateTimeOriginal != "2024-03-14T15:09:26" {
		t.Errorf("DateTimeOriginal = %q", metadata.DateTimeOriginal)
	}
	if metadata.Orientation != 6 {
		t.Errorf("orientation = %d, want 6", metadata.Orientation)
	}
	if metadata.CameraMake != "acme" || metadata.CameraModel != "Model X" {
		t.Errorf("camera = %q %q", metadata.CameraMake, metadata.CameraModel)
	}
	if metadata.GPS == nil {
		t.Fatal("GPS metadata is missing")
	}
	if math.Abs(metadata.GPS.Latitude+37.5) > 1e-7 || math.Abs(metadata.GPS.Longitude+122.25) > 1e-7 {
		t.Errorf("coordinates = (%f, %f)", metadata.GPS.Latitude, metadata.GPS.Longitude)
	}
	if metadata.GPS.AltitudeMeters == nil || *metadata.GPS.AltitudeMeters != 12 {
		t.Errorf("altitude = %v, want 12 meters", metadata.GPS.AltitudeMeters)
	}
	if metadata.GPS.DateTime != "2024-03-14T15:09:26Z" {
		t.Errorf("GPS time = %q", metadata.GPS.DateTime)
	}
	if metadata.GPS.ImageDirectionDegrees == nil || *metadata.GPS.ImageDirectionDegrees != 87.5 || metadata.GPS.ImageDirectionReference != "T" {
		var direction float64
		if metadata.GPS.ImageDirectionDegrees != nil {
			direction = *metadata.GPS.ImageDirectionDegrees
		}
		t.Errorf("image direction = %f %q", direction, metadata.GPS.ImageDirectionReference)
	}
	if metadata.GPS.MapDatum != "WGS-84" {
		t.Errorf("map datum = %q", metadata.GPS.MapDatum)
	}
}

func TestParseImageMetadataDoesNotInventMissingAltitude(t *testing.T) {
	metadata, err := ParseImageMetadata(bytes.NewReader(testExifJPEGWithoutAltitude()))
	if err != nil {
		t.Fatalf("ParseImageMetadata() error = %v", err)
	}
	if metadata.GPS == nil || metadata.GPS.AltitudeMeters != nil {
		t.Fatalf("missing altitude = %v, want nil", metadata.GPS)
	}
}

func TestParseImageMetadataDoesNotInventCoordinatesFromGPSVersionOnly(t *testing.T) {
	metadata, err := ParseImageMetadata(bytes.NewReader(testExifJPEGWithoutCoordinates()))
	if err != nil {
		t.Fatalf("ParseImageMetadata() error = %v", err)
	}
	if metadata.GPS != nil {
		t.Fatalf("GPS metadata without coordinate tags = %+v, want nil", metadata.GPS)
	}
}

func TestParseImageMetadataTreatsMissingEXIFAsNormal(t *testing.T) {
	metadata, err := ParseImageMetadata(bytes.NewReader([]byte{0xff, 0xd8, 0xff, 0xd9}))
	if err != nil {
		t.Fatalf("ParseImageMetadata() error = %v", err)
	}
	if metadata.Status != MetadataParseNoExif && metadata.Status != MetadataParseUnsupported {
		t.Fatalf("status = %q, want no_exif or unsupported", metadata.Status)
	}
}

func TestParseImageMetadataTreatsDamagedEXIFAsAnErrorWithoutPanicking(t *testing.T) {
	for _, value := range [][]byte{
		{0xff, 0xd8, 0xff, 0xe1, 0, 10, 'E', 'x', 'i', 'f', 0},
		{0xff, 0xd8, 0xff, 0xe1, 0, 8, 'E', 'x', 'i', 'f', 0, 0, 0xff, 0xd9},
	} {
		if _, err := ParseImageMetadata(bytes.NewReader(value)); err == nil {
			t.Fatal("ParseImageMetadata() accepted damaged EXIF")
		}
	}
}

func TestValidCoordinatesRejectsInvalidAndNonFiniteValues(t *testing.T) {
	for _, test := range []struct {
		latitude  float64
		longitude float64
		want      bool
	}{
		{latitude: 45, longitude: 180, want: true},
		{latitude: -90, longitude: -180, want: true},
		{latitude: 0, longitude: 0, want: true},
		{latitude: 91, longitude: 0, want: false},
		{latitude: 0, longitude: math.NaN(), want: false},
	} {
		if got := validCoordinates(test.latitude, test.longitude); got != test.want {
			t.Errorf("validCoordinates(%v, %v) = %v, want %v", test.latitude, test.longitude, got, test.want)
		}
	}
}

type exifFixtureEntry struct {
	tag      uint16
	typeID   uint16
	count    uint32
	inline   []byte
	external []byte
}

func testExifJPEG() []byte {
	return testExifJPEGWithAltitude(true)
}

func testExifJPEGWithoutAltitude() []byte {
	return testExifJPEGWithAltitude(false)
}

func testExifJPEGWithAltitude(includeAltitude bool) []byte {
	return testExifJPEGWithOptions(includeAltitude, true)
}

func testExifJPEGWithoutCoordinates() []byte {
	return testExifJPEGWithOptions(true, false)
}

func testExifJPEGWithOptions(includeAltitude, includeCoordinates bool) []byte {
	const (
		ifd0Offset  = 8
		ifd0Size    = 2 + 5*12 + 4
		exifOffset  = ifd0Offset + ifd0Size
		exifSize    = 2 + 1*12 + 4
		gpsOffset   = exifOffset + exifSize
		gpsEntryNum = 12
		gpsSize     = 2 + gpsEntryNum*12 + 4
	)
	tiff := make([]byte, 8+ifd0Size+exifSize+gpsSize)
	copy(tiff[:2], "II")
	binary.LittleEndian.PutUint16(tiff[2:4], 42)
	binary.LittleEndian.PutUint32(tiff[4:8], ifd0Offset)
	dataOffset := uint32(len(tiff))

	ifd0 := []exifFixtureEntry{
		{tag: 0x010f, typeID: 2, count: 5, external: []byte("Acme\x00")},
		{tag: 0x0110, typeID: 2, count: 8, external: []byte("Model X\x00")},
		{tag: 0x0112, typeID: 3, count: 1, inline: littleEndian16(6)},
		{tag: 0x8769, typeID: 4, count: 1, inline: littleEndian32(exifOffset)},
		{tag: 0x8825, typeID: 4, count: 1, inline: littleEndian32(gpsOffset)},
	}
	exifIFD := []exifFixtureEntry{
		{tag: 0x9003, typeID: 2, count: 20, external: []byte("2024:03:14 15:09:26\x00")},
	}
	gpsIFD := []exifFixtureEntry{
		{tag: 0x0000, typeID: 1, count: 4, inline: []byte{2, 3, 0, 0}},
		{tag: 0x0001, typeID: 2, count: 2, inline: []byte{'S', 0}},
		{tag: 0x0002, typeID: 5, count: 3, external: rationals(37, 1, 30, 1, 0, 1)},
		{tag: 0x0003, typeID: 2, count: 2, inline: []byte{'W', 0}},
		{tag: 0x0004, typeID: 5, count: 3, external: rationals(122, 1, 15, 1, 0, 1)},
		{tag: 0x0005, typeID: 1, count: 1, inline: []byte{0}},
		{tag: 0x0006, typeID: 5, count: 1, external: rationals(12, 1)},
		{tag: 0x0007, typeID: 5, count: 3, external: rationals(15, 1, 9, 1, 26, 1)},
		{tag: 0x0010, typeID: 2, count: 2, inline: []byte{'T', 0}},
		{tag: 0x0011, typeID: 5, count: 1, external: rationals(175, 2)},
		{tag: 0x0012, typeID: 2, count: 7, external: []byte("WGS-84\x00")},
		{tag: 0x001d, typeID: 2, count: 11, external: []byte("2024:03:14\x00")},
	}
	if !includeAltitude {
		gpsIFD = append(gpsIFD[:6], gpsIFD[7:]...)
	}
	if !includeCoordinates {
		filtered := gpsIFD[:0]
		for _, entry := range gpsIFD {
			if entry.tag >= 0x0001 && entry.tag <= 0x0004 {
				continue
			}
			filtered = append(filtered, entry)
		}
		gpsIFD = filtered
	}
	tiff, dataOffset = writeExifFixtureIFD(tiff, ifd0Offset, ifd0, 0, dataOffset)
	tiff, dataOffset = writeExifFixtureIFD(tiff, exifOffset, exifIFD, 0, dataOffset)
	tiff, _ = writeExifFixtureIFD(tiff, gpsOffset, gpsIFD, 0, dataOffset)

	payload := append([]byte("Exif\x00\x00"), tiff...)
	segmentLength := uint16(len(payload) + 2)
	jpeg := []byte{0xff, 0xd8, 0xff, 0xe1, byte(segmentLength >> 8), byte(segmentLength)}
	jpeg = append(jpeg, payload...)
	return append(jpeg, 0xff, 0xd9)
}

func writeExifFixtureIFD(tiff []byte, offset uint32, entries []exifFixtureEntry, next uint32, dataOffset uint32) ([]byte, uint32) {
	base := int(offset)
	binary.LittleEndian.PutUint16(tiff[base:base+2], uint16(len(entries)))
	for index, entry := range entries {
		position := base + 2 + index*12
		binary.LittleEndian.PutUint16(tiff[position:position+2], entry.tag)
		binary.LittleEndian.PutUint16(tiff[position+2:position+4], entry.typeID)
		binary.LittleEndian.PutUint32(tiff[position+4:position+8], entry.count)
		if entry.external != nil {
			binary.LittleEndian.PutUint32(tiff[position+8:position+12], dataOffset)
			tiff = append(tiff, entry.external...)
			dataOffset += uint32(len(entry.external))
		} else {
			copy(tiff[position+8:position+12], entry.inline)
		}
	}
	nextPosition := base + 2 + len(entries)*12
	binary.LittleEndian.PutUint32(tiff[nextPosition:nextPosition+4], next)
	return tiff, dataOffset
}

func littleEndian16(value uint16) []byte {
	data := make([]byte, 2)
	binary.LittleEndian.PutUint16(data, value)
	return data
}

func littleEndian32(value uint32) []byte {
	data := make([]byte, 4)
	binary.LittleEndian.PutUint32(data, value)
	return data
}

func rationals(values ...uint32) []byte {
	data := make([]byte, len(values)*4)
	for index, value := range values {
		binary.LittleEndian.PutUint32(data[index*4:index*4+4], value)
	}
	return data
}
