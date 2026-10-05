"""Generate the sample ShippingService (shared common XSD + per-service XSD and WSDL).

Usage: python3 scripts/generate-samples.py <output-dir>
"""
import os
import sys

OUT = sys.argv[1]
BASE = "http://samples.acme-commerce.com"
CMN_NS = f"{BASE}/schemas/common/v1"

# ---------- field DSL ----------
# (name, type, occurs) where type is:
#   "xs:..." / "cmn:..." / "t:..."  -> type reference
#   [fields...]                     -> anonymous complex type (sequence)
#   ("enum", [values])              -> anonymous enum
#   ("choice", [fields...])         -> xs:choice of the given fields (name ignored)
#   ("str", maxLength) / ("pattern", regex)
# occurs: "1" (default), "?", "*", "+", or "1..N"


def occ(o):
    simple = {"1": "", "?": ' minOccurs="0"', "*": ' minOccurs="0" maxOccurs="unbounded"', "+": ' maxOccurs="unbounded"'}
    if o in simple:
        return simple[o]
    a, b = o.split("..")
    return f' minOccurs="{a}" maxOccurs="{b}"'


def fields_xml(fields, ind):
    pad = " " * ind
    out = []
    for f in fields:
        name, typ = f[0], f[1]
        o = occ(f[2] if len(f) > 2 else "1")
        doc = f[3] if len(f) > 3 else None
        ann = f'{pad}  <xs:annotation><xs:documentation>{doc}</xs:documentation></xs:annotation>\n' if doc else ""
        if isinstance(typ, tuple) and typ[0] == "choice":
            out.append(f"{pad}<xs:choice{o}>\n{fields_xml(typ[1], ind + 2)}{pad}</xs:choice>\n")
        elif isinstance(typ, list):
            out.append(f'{pad}<xs:element name="{name}"{o}>\n{ann}{pad}  <xs:complexType>\n{pad}    <xs:sequence>\n'
                       f'{fields_xml(typ, ind + 6)}{pad}    </xs:sequence>\n{pad}  </xs:complexType>\n{pad}</xs:element>\n')
        elif isinstance(typ, tuple):
            kind, arg = typ
            if kind == "enum":
                body = "".join(f'{pad}      <xs:enumeration value="{v}"/>\n' for v in arg)
                base = "xs:string"
            elif kind == "str":
                body, base = f'{pad}      <xs:maxLength value="{arg}"/>\n', "xs:string"
            elif kind == "pattern":
                body, base = f'{pad}      <xs:pattern value="{arg}"/>\n', "xs:string"
            elif kind == "range":
                body = f'{pad}      <xs:minInclusive value="{arg[0]}"/>\n{pad}      <xs:maxInclusive value="{arg[1]}"/>\n'
                base = "xs:int"
            out.append(f'{pad}<xs:element name="{name}"{o}>\n{ann}{pad}  <xs:simpleType>\n{pad}    <xs:restriction base="{base}">\n'
                       f'{body}{pad}    </xs:restriction>\n{pad}  </xs:simpleType>\n{pad}</xs:element>\n')
        else:
            if ann:
                out.append(f'{pad}<xs:element name="{name}" type="{typ}"{o}>\n{ann}{pad}</xs:element>\n')
            else:
                out.append(f'{pad}<xs:element name="{name}" type="{typ}"{o}/>\n')
    return "".join(out)


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        fh.write(text)



# ---------- shared common schema (Acme Commerce) ----------
COMMON = f'''<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
           xmlns:cmn="{CMN_NS}"
           targetNamespace="{CMN_NS}"
           elementFormDefault="qualified">
  <xs:annotation><xs:documentation>Common types shared by all Acme Commerce services.</xs:documentation></xs:annotation>

  <xs:simpleType name="CurrencyCode">
    <xs:annotation><xs:documentation>ISO 4217 alphabetic currency code.</xs:documentation></xs:annotation>
    <xs:restriction base="xs:string"><xs:pattern value="[A-Z]{{3}}"/></xs:restriction>
  </xs:simpleType>

  <xs:simpleType name="Sku">
    <xs:annotation><xs:documentation>Stock keeping unit, e.g. ACM-100234.</xs:documentation></xs:annotation>
    <xs:restriction base="xs:string"><xs:pattern value="[A-Z]{{3}}-[0-9]{{6}}"/></xs:restriction>
  </xs:simpleType>

  <xs:simpleType name="WarehouseCode">
    <xs:restriction base="xs:string"><xs:pattern value="WH[0-9]{{3}}"/></xs:restriction>
  </xs:simpleType>

  <xs:simpleType name="SalesChannel">
    <xs:restriction base="xs:string">
      <xs:enumeration value="WEB"/><xs:enumeration value="MOBILE_APP"/><xs:enumeration value="STORE"/>
      <xs:enumeration value="MARKETPLACE"/><xs:enumeration value="CALL_CENTRE"/>
    </xs:restriction>
  </xs:simpleType>

  <xs:complexType name="Money">
    <xs:simpleContent>
      <xs:extension base="xs:decimal">
        <xs:attribute name="currency" type="cmn:CurrencyCode" use="required"/>
      </xs:extension>
    </xs:simpleContent>
  </xs:complexType>

  <xs:complexType name="Measure">
    <xs:simpleContent>
      <xs:extension base="xs:decimal">
        <xs:attribute name="unit" use="required">
          <xs:simpleType><xs:restriction base="xs:string">
            <xs:enumeration value="KG"/><xs:enumeration value="G"/><xs:enumeration value="CM"/><xs:enumeration value="M"/>
          </xs:restriction></xs:simpleType>
        </xs:attribute>
      </xs:extension>
    </xs:simpleContent>
  </xs:complexType>

  <xs:complexType name="DateRange">
    <xs:sequence>
      <xs:element name="FromDate" type="xs:date"/>
      <xs:element name="ToDate" type="xs:date"/>
    </xs:sequence>
  </xs:complexType>

  <xs:complexType name="Pagination">
    <xs:sequence>
      <xs:element name="PageNumber" type="xs:int" minOccurs="0"/>
      <xs:element name="PageSize" minOccurs="0">
        <xs:simpleType><xs:restriction base="xs:int"><xs:minInclusive value="1"/><xs:maxInclusive value="200"/></xs:restriction></xs:simpleType>
      </xs:element>
    </xs:sequence>
  </xs:complexType>

  <xs:complexType name="Address">
    <xs:sequence>
      <xs:element name="Recipient" type="xs:string"/>
      <xs:element name="Line1" type="xs:string"/>
      <xs:element name="Line2" type="xs:string" minOccurs="0"/>
      <xs:element name="City" type="xs:string"/>
      <xs:element name="Region" type="xs:string" minOccurs="0"/>
      <xs:element name="PostalCode" type="xs:string"/>
      <xs:element name="CountryCode">
        <xs:simpleType><xs:restriction base="xs:string"><xs:length value="2"/></xs:restriction></xs:simpleType>
      </xs:element>
      <xs:element name="Phone" type="xs:string" minOccurs="0"/>
    </xs:sequence>
  </xs:complexType>

  <xs:complexType name="ResponseStatus">
    <xs:sequence>
      <xs:element name="StatusCode">
        <xs:simpleType><xs:restriction base="xs:string">
          <xs:enumeration value="SUCCESS"/><xs:enumeration value="PARTIAL"/><xs:enumeration value="FAILED"/>
        </xs:restriction></xs:simpleType>
      </xs:element>
      <xs:element name="Message" type="xs:string" minOccurs="0"/>
    </xs:sequence>
  </xs:complexType>

  <xs:element name="RequestContext">
    <xs:annotation><xs:documentation>Caller context sent in the SOAP header of every call.</xs:documentation></xs:annotation>
    <xs:complexType>
      <xs:sequence>
        <xs:element name="RequestId" type="xs:string"/>
        <xs:element name="CorrelationId" type="xs:string" minOccurs="0"/>
        <xs:element name="Channel" type="cmn:SalesChannel"/>
        <xs:element name="StoreCode" type="xs:string" minOccurs="0"/>
        <xs:element name="ClientApplication" type="xs:string"/>
        <xs:element name="Timestamp" type="xs:dateTime"/>
        <xs:element name="Locale" type="xs:language" default="en-GB"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>

  <xs:element name="ValidationFault">
    <xs:annotation><xs:documentation>The request broke a business rule; fix the input before retrying.</xs:documentation></xs:annotation>
    <xs:complexType>
      <xs:sequence>
        <xs:element name="Code" type="xs:string"/>
        <xs:element name="Message" type="xs:string"/>
        <xs:element name="Violation" minOccurs="0" maxOccurs="unbounded">
          <xs:complexType><xs:sequence>
            <xs:element name="Field" type="xs:string"/>
            <xs:element name="Problem" type="xs:string"/>
          </xs:sequence></xs:complexType>
        </xs:element>
      </xs:sequence>
    </xs:complexType>
  </xs:element>

  <xs:element name="SystemFault">
    <xs:annotation><xs:documentation>A downstream system failed; the call may be retried.</xs:documentation></xs:annotation>
    <xs:complexType>
      <xs:sequence>
        <xs:element name="Code" type="xs:string"/>
        <xs:element name="Message" type="xs:string"/>
        <xs:element name="Retryable" type="xs:boolean"/>
        <xs:element name="System" type="xs:string" minOccurs="0"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>
'''
# ---------- service generator ----------
def service(folder, name, prefix, doc, ops, types="", soap12=False, endpoint=None):
    ns = f"{BASE}/schemas/{prefix}/v1"
    sns = f"{BASE}/services/{prefix}/v1"
    elems = []
    for op in ops:
        for kind in ("Request", "Response"):
            fs = op.get(kind.lower())
            if fs is None:
                continue
            if kind == "Response":
                fs = [("Status", "cmn:ResponseStatus")] + fs
            elems.append(f'  <xs:element name="{op["name"]}{kind}">\n'
                         + (f'    <xs:annotation><xs:documentation>{op["doc"]}</xs:documentation></xs:annotation>\n' if kind == "Request" and op.get("doc") else "")
                         + f'    <xs:complexType>\n      <xs:sequence>\n{fields_xml(fs, 8)}      </xs:sequence>\n    </xs:complexType>\n  </xs:element>\n')
    xsd = f'''<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
           xmlns:t="{ns}"
           xmlns:cmn="{CMN_NS}"
           targetNamespace="{ns}"
           elementFormDefault="qualified">
  <xs:import namespace="{CMN_NS}" schemaLocation="../shared/AcmeCommon.xsd"/>
{types}
{"".join(elems)}</xs:schema>
'''
    msgs, pt_ops, b11, b12 = [], [], [], []
    for op in ops:
        n = op["name"]
        msgs.append(f'  <wsdl:message name="{n}Request"><wsdl:part name="body" element="t:{n}Request"/></wsdl:message>\n')
        has_out = op.get("response") is not None
        if has_out:
            msgs.append(f'  <wsdl:message name="{n}Response"><wsdl:part name="body" element="t:{n}Response"/></wsdl:message>\n')
        faults = op.get("faults", ["ValidationFault", "SystemFault"] if has_out else [])
        pt_ops.append(f'    <wsdl:operation name="{n}">\n'
                      + (f'      <wsdl:documentation>{op["doc"]}</wsdl:documentation>\n' if op.get("doc") else "")
                      + f'      <wsdl:input message="tns:{n}Request"/>\n'
                      + (f'      <wsdl:output message="tns:{n}Response"/>\n' if has_out else "")
                      + "".join(f'      <wsdl:fault name="{f}" message="tns:{f}"/>\n' for f in faults)
                      + '    </wsdl:operation>\n')
        for lst, sp in ((b11, "soap"), (b12, "soap12")):
            lst.append(f'    <wsdl:operation name="{n}">\n      <{sp}:operation soapAction="{sns}/{n}"/>\n'
                       f'      <wsdl:input><{sp}:header message="tns:RequestContext" part="header" use="literal"/><{sp}:body use="literal"/></wsdl:input>\n'
                       + (f'      <wsdl:output><{sp}:body use="literal"/></wsdl:output>\n' if has_out else "")
                       + "".join(f'      <wsdl:fault name="{f}"><{sp}:fault name="{f}" use="literal"/></wsdl:fault>\n' for f in faults)
                       + '    </wsdl:operation>\n')
    ep = endpoint or f"https://soa.acme-commerce.com/{prefix}/v1"
    binding12 = (f'  <wsdl:binding name="{name}Soap12" type="tns:{name}PortType">\n'
                 f'    <soap12:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>\n{"".join(b12)}  </wsdl:binding>\n\n') if soap12 else ""
    port12 = (f'    <wsdl:port name="{name}Soap12Port" binding="tns:{name}Soap12">\n'
              f'      <soap12:address location="{ep}/soap12"/>\n    </wsdl:port>\n') if soap12 else ""
    wsdl = f'''<?xml version="1.0" encoding="UTF-8"?>
<wsdl:definitions name="{name}"
    xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"
    xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
    xmlns:soap12="http://schemas.xmlsoap.org/wsdl/soap12/"
    xmlns:xs="http://www.w3.org/2001/XMLSchema"
    xmlns:tns="{sns}"
    xmlns:t="{ns}"
    xmlns:cmn="{CMN_NS}"
    targetNamespace="{sns}">
  <wsdl:documentation>{doc}</wsdl:documentation>
  <wsdl:types>
    <xs:schema>
      <xs:import namespace="{ns}" schemaLocation="{name}.xsd"/>
      <xs:import namespace="{CMN_NS}" schemaLocation="../shared/AcmeCommon.xsd"/>
    </xs:schema>
  </wsdl:types>

  <wsdl:message name="RequestContext"><wsdl:part name="header" element="cmn:RequestContext"/></wsdl:message>
  <wsdl:message name="ValidationFault"><wsdl:part name="fault" element="cmn:ValidationFault"/></wsdl:message>
  <wsdl:message name="SystemFault"><wsdl:part name="fault" element="cmn:SystemFault"/></wsdl:message>
{"".join(msgs)}
  <wsdl:portType name="{name}PortType">
{"".join(pt_ops)}  </wsdl:portType>

  <wsdl:binding name="{name}Soap11" type="tns:{name}PortType">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
{"".join(b11)}  </wsdl:binding>

{binding12}  <wsdl:service name="{name}">
    <wsdl:documentation>{doc}</wsdl:documentation>
    <wsdl:port name="{name}Soap11Port" binding="tns:{name}Soap11">
      <soap:address location="{ep}"/>
    </wsdl:port>
{port12}  </wsdl:service>
</wsdl:definitions>
'''
    write(os.path.join(OUT, folder, f"{name}.xsd"), xsd)
    write(os.path.join(OUT, folder, f"{name}.wsdl"), wsdl)



write(os.path.join(OUT, "shared", "AcmeCommon.xsd"), COMMON)

service("shipping", "ShippingService", "shipping",
        "Carrier rates, shipment creation, labels and tracking.", ops=[
            {"name": "GetShippingRates", "doc": "Compare carrier options for a parcel.",
             "request": [("FromWarehouse", "cmn:WarehouseCode"), ("Destination", "cmn:Address"),
                         ("Parcel", [("Weight", "cmn:Measure"), ("Length", "cmn:Measure"), ("Width", "cmn:Measure"),
                                     ("Height", "cmn:Measure"), ("DeclaredValue", "cmn:Money", "?")], "+")],
             "response": [("Rate", [("Carrier", ("enum", ["DHL", "UPS", "FEDEX", "ROYAL_MAIL", "ARAMEX"])), ("ServiceLevel", "xs:string"),
                                    ("Price", "cmn:Money"), ("TransitDays", "xs:int"), ("Guaranteed", "xs:boolean")], "*")]},
            {"name": "CreateShipment", "doc": "Book a carrier and return labels for each parcel.",
             "request": [("OrderNumber", "xs:string"), ("Carrier", ("enum", ["DHL", "UPS", "FEDEX", "ROYAL_MAIL", "ARAMEX"])),
                         ("ServiceLevel", "xs:string"), ("FromWarehouse", "cmn:WarehouseCode"), ("Destination", "cmn:Address"),
                         ("Parcel", [("Weight", "cmn:Measure"), ("Content", [("Sku", "cmn:Sku"), ("Quantity", "xs:int")], "+")], "+"),
                         ("LabelFormat", ("enum", ["PDF", "ZPL", "PNG"]), "?")],
             "response": [("ShipmentId", "xs:string"), ("TrackingNumber", "xs:string"),
                          ("Label", [("ParcelIndex", "xs:int"), ("Format", "xs:string"), ("Data", "xs:base64Binary")], "+"),
                          ("PickupWindow", [("From", "xs:dateTime"), ("To", "xs:dateTime")], "?")]},
            {"name": "TrackShipment",
             "request": [("x", ("choice", [("TrackingNumber", "xs:string"), ("OrderNumber", "xs:string")]))],
             "response": [("TrackingNumber", "xs:string"), ("Carrier", "xs:string"),
                          ("CurrentStatus", ("enum", ["LABEL_CREATED", "PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "EXCEPTION"])),
                          ("EstimatedDelivery", "xs:date", "?"),
                          ("Event", [("At", "xs:dateTime"), ("Location", "xs:string"), ("Description", "xs:string")], "*"),
                          ("ProofOfDelivery", [("SignedBy", "xs:string"), ("PhotoUrl", "xs:anyURI", "?")], "?")]},
            {"name": "CancelShipment",
             "request": [("ShipmentId", "xs:string")],
             "response": []},
        ])

print("generated into", OUT)
