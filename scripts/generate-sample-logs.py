"""Generate sample call logs (CSV) for the ShippingService example: one file per day.

Usage: python3 scripts/generate-sample-logs.py [output-dir]   (default: logs/)

Writes "Shipping Logs - Day 1.csv" and "Shipping Logs - Day 2.csv". The columns mirror a typical
host-log export. All values are made up.
"""
import csv
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone

OUT_DIR = sys.argv[1] if len(sys.argv) > 1 else "logs"
DAYS = 2
T = "http://samples.acme-commerce.com/schemas/shipping/v1"
C = "http://samples.acme-commerce.com/schemas/common/v1"
ENV = "http://schemas.xmlsoap.org/soap/envelope/"
NS = f'xmlns:t="{T}" xmlns:cmn="{C}"'
TZ = timezone(timedelta(hours=3))

HEADER = ["UUID", "User Id", "Username", "Short CIF", "Channel", "IP Address", "UUID", "Request", "Request Extra",
          "Request Extra 2", "Request Timestamp", "Response", "Response Extra", "Response Extra 2", "Response Timestmap",
          "Service", "Operation", "Server", "Journal ID", "Error Type", "Error Message", "User Type", "Language", "MFA",
          "Session ID", "Error Number", "System", "Native Error", "Application"]

DESTINATIONS = [
    ("Sara Ahmed", "14 King Fahd Road", "Riyadh", "12271", "SA", "+966501234567"),
    ("Oliver Grant", "221 Baker Street", "London", "NW1 6XE", "GB", "+447700900123"),
    ("Lena Fischer", "Hauptstrasse 5", "Berlin", "10115", "DE", None),
    ("Omar Haddad", "Al Wasl Road, Villa 9", "Dubai", "00000", "AE", "+971501112233"),
]


def address(d):
    name, line1, city, postal, country, phone = d
    return (f"<t:Destination><cmn:Recipient>{name}</cmn:Recipient><cmn:Line1>{line1}</cmn:Line1>"
            f"<cmn:City>{city}</cmn:City><cmn:PostalCode>{postal}</cmn:PostalCode><cmn:CountryCode>{country}</cmn:CountryCode>"
            + (f"<cmn:Phone>{phone}</cmn:Phone>" if phone else "") + "</t:Destination>")


def status(code="SUCCESS", msg=None):
    return f"<t:Status><cmn:StatusCode>{code}</cmn:StatusCode>" + (f"<cmn:Message>{msg}</cmn:Message>" if msg else "") + "</t:Status>"


def envelope(body, request_id=None):
    header = ""
    if request_id:
        header = (f'<cmn:RequestContext xmlns:cmn="{C}"><cmn:RequestId>{request_id}</cmn:RequestId><cmn:Channel>WEB</cmn:Channel>'
                  f"<cmn:ClientApplication>acme-storefront</cmn:ClientApplication><cmn:Timestamp>2026-11-24T08:15:02Z</cmn:Timestamp>"
                  "<cmn:Locale>en-GB</cmn:Locale></cmn:RequestContext>")
    return f'<soapenv:Envelope xmlns:soapenv="{ENV}"><soapenv:Header>{header}</soapenv:Header><soapenv:Body>{body}</soapenv:Body></soapenv:Envelope>'


def fault(kind, code, message, extra=""):
    detail = (f'<cmn:{kind} xmlns:cmn="{C}"><cmn:Code>{code}</cmn:Code><cmn:Message>{message}</cmn:Message>{extra}</cmn:{kind}>')
    return envelope(f"<soapenv:Fault><faultcode>soapenv:{'Client' if kind == 'ValidationFault' else 'Server'}</faultcode>"
                    f"<faultstring>{message}</faultstring><detail>{detail}</detail></soapenv:Fault>")


def parcel_rates(kg, l, w, h, value=None):
    return (f'<t:Parcel><t:Weight unit="KG">{kg}</t:Weight><t:Length unit="CM">{l}</t:Length><t:Width unit="CM">{w}</t:Width>'
            f'<t:Height unit="CM">{h}</t:Height>' + (f'<t:DeclaredValue currency="SAR">{value}</t:DeclaredValue>' if value else "") + "</t:Parcel>")


def rate(carrier, level, price, cur, days, guaranteed):
    return (f"<t:Rate><t:Carrier>{carrier}</t:Carrier><t:ServiceLevel>{level}</t:ServiceLevel>"
            f'<t:Price currency="{cur}">{price}</t:Price><t:TransitDays>{days}</t:TransitDays><t:Guaranteed>{str(guaranteed).lower()}</t:Guaranteed></t:Rate>')


LABEL = "JVBERi0xLjQKJcfsj6IKNSAwIG9iago8PC9MZW5ndGggNiAwIFI+PgpzdHJlYW0K"  # truncated PDF header, base64

def call(calls, op, request, response, *, start, ms, channel="WEB", error=None):
    calls.append((op, request, response, start, ms, channel, error))


def calls_for(day):
    """Calls for one day; day 1 and day 2 differ in times, IDs, destinations and latency."""
    dest_for = lambda i: DESTINATIONS[(i + day - 1) % len(DESTINATIONS)]
    jitter = lambda ms: int(ms * (1 + 0.35 * (day - 1)))
    calls = []
    base = datetime(2026, 11, 23 + day, 8 + day, 0, 0, tzinfo=TZ)
    at = lambda minutes: base + timedelta(minutes=minutes)
    d0, d1, d2 = [(base + timedelta(days=k)).date().isoformat() for k in range(3)]

    # GetShippingRates
    call(calls, "GetShippingRates",
         f"<t:GetShippingRatesRequest {NS}><t:FromWarehouse>WH101</t:FromWarehouse>{address(dest_for(0))}{parcel_rates('2.4', 40, 30, 15, '450.00')}</t:GetShippingRatesRequest>",
         f"<t:GetShippingRatesResponse {NS}>{status()}{rate('ARAMEX', 'Express', '38.50', 'SAR', 1, True)}{rate('DHL', 'Economy', '29.00', 'SAR', 3, False)}{rate('FEDEX', 'Priority', '61.75', 'SAR', 1, True)}</t:GetShippingRatesResponse>",
         start=at(3), ms=412, channel="WEB")
    call(calls, "GetShippingRates",
         f"<t:GetShippingRatesRequest {NS}><t:FromWarehouse>WH204</t:FromWarehouse>{address(dest_for(1))}{parcel_rates('0.8', 25, 18, 6)}{parcel_rates('5.1', 60, 40, 30)}</t:GetShippingRatesRequest>",
         f"<t:GetShippingRatesResponse {NS}>{status()}{rate('ROYAL_MAIL', 'Tracked 48', '7.95', 'GBP', 2, False)}{rate('UPS', 'Standard', '14.20', 'GBP', 2, False)}</t:GetShippingRatesResponse>",
         start=at(19), ms=655, channel="MOBILE_APP")
    call(calls, "GetShippingRates",
         f"<t:GetShippingRatesRequest {NS}><t:FromWarehouse>WH101</t:FromWarehouse>{address(dest_for(2))}{parcel_rates('-1', 10, 10, 10)}</t:GetShippingRatesRequest>",
         fault("ValidationFault", "VAL-012", "Parcel weight must be greater than zero",
               "<cmn:Violation><cmn:Field>Parcel[1]/Weight</cmn:Field><cmn:Problem>must be &gt; 0</cmn:Problem></cmn:Violation>"),
         start=at(27), ms=38, channel="WEB")

    # CreateShipment
    for i, (order, carrier, level, dest, kg, items, fmt, ch, minute, ms) in enumerate([
        (f"ORD-{552187 + day * 1000}", "ARAMEX", "Express", dest_for(0), "2.4", [("ACM-100234", 1), ("ACM-100871", 2)], "PDF", "WEB", 6, 1180),
        (f"ORD-{552203 + day * 1000}", "ROYAL_MAIL", "Tracked 48", dest_for(1), "0.8", [("ACM-204511", 1)], "ZPL", "STORE", 33, 940),
        (f"ORD-{552219 + day * 1000}", "DHL", "Economy", dest_for(3), "3.7", [("ACM-310002", 3)], "PDF", "MOBILE_APP", 58, 1320),
    ]):
        contents = "".join(f"<t:Content><t:Sku>{s}</t:Sku><t:Quantity>{q}</t:Quantity></t:Content>" for s, q in items)
        body = (f"<t:CreateShipmentRequest {NS}><t:OrderNumber>{order}</t:OrderNumber><t:Carrier>{carrier}</t:Carrier>"
                f"<t:ServiceLevel>{level}</t:ServiceLevel><t:FromWarehouse>WH101</t:FromWarehouse>{address(dest)}"
                f'<t:Parcel><t:Weight unit="KG">{kg}</t:Weight>{contents}</t:Parcel><t:LabelFormat>{fmt}</t:LabelFormat></t:CreateShipmentRequest>')
        sid = f"SHP-{880410 + day * 500 + i * 37}"
        trk = f"{carrier[:2]}{7300112450 + day * 100 + i * 9}"
        resp = (f"<t:CreateShipmentResponse {NS}>{status()}<t:ShipmentId>{sid}</t:ShipmentId><t:TrackingNumber>{trk}</t:TrackingNumber>"
                f"<t:Label><t:ParcelIndex>1</t:ParcelIndex><t:Format>{fmt}</t:Format><t:Data>{LABEL}</t:Data></t:Label>"
                f"<t:PickupWindow><t:From>{d0}T14:00:00+03:00</t:From><t:To>{d0}T18:00:00+03:00</t:To></t:PickupWindow></t:CreateShipmentResponse>")
        # one call is logged as a full SOAP envelope, the way some gateways record it
        call(calls, "CreateShipment", envelope(body, "REQ-77012") if i == 0 else body, envelope(resp) if i == 0 else resp,
             start=at(minute), ms=ms, channel=ch)
    call(calls, "CreateShipment",
         f"<t:CreateShipmentRequest {NS}><t:OrderNumber>ORD-{552230 + day * 1000}</t:OrderNumber><t:Carrier>FEDEX</t:Carrier><t:ServiceLevel>Priority</t:ServiceLevel>"
         f"<t:FromWarehouse>WH204</t:FromWarehouse>{address(dest_for(2))}"
         f'<t:Parcel><t:Weight unit="KG">1.2</t:Weight><t:Content><t:Sku>ACM-120044</t:Sku><t:Quantity>1</t:Quantity></t:Content></t:Parcel></t:CreateShipmentRequest>',
         "", start=at(71), ms=30000, channel="WEB", error=("TECHNICAL", "Carrier gateway timed out after 30s", "504"))

    # TrackShipment
    tracks = [
        (f"AR{7300112450 + day * 100}", "ARAMEX", "OUT_FOR_DELIVERY", d1,
         [(f"{d0}T15:10:00+03:00", "Riyadh Hub", "Picked up"), (f"{d1}T07:42:00+03:00", "Riyadh North DC", "Out for delivery")], None),
        (f"RO{7300112459 + day * 100}", "ROYAL_MAIL", "IN_TRANSIT", d2,
         [(f"{d0}T17:05:00+00:00", "Mount Pleasant MC", "Received at mail centre")], None),
        (f"DH{7300112468 + day * 100}", "DHL", "DELIVERED", None,
         [(f"{d0}T16:00:00+04:00", "Dubai Hub", "Picked up"), (f"{d1}T11:20:00+04:00", "Jumeirah", "Delivered")], ("Omar Haddad", f"https://pod.example.com/DH{7300112468 + day * 100}.jpg")),
    ]
    for i, (trk, carrier, cur, eta, events, pod) in enumerate(tracks):
        req_body = f"<t:TrackShipmentRequest {NS}><t:TrackingNumber>{trk}</t:TrackingNumber></t:TrackShipmentRequest>" if i != 1 else \
            f"<t:TrackShipmentRequest {NS}><t:OrderNumber>ORD-{552203 + day * 1000}</t:OrderNumber></t:TrackShipmentRequest>"
        ev = "".join(f"<t:Event><t:At>{a}</t:At><t:Location>{l}</t:Location><t:Description>{d}</t:Description></t:Event>" for a, l, d in events)
        pod_xml = f"<t:ProofOfDelivery><t:SignedBy>{pod[0]}</t:SignedBy><t:PhotoUrl>{pod[1]}</t:PhotoUrl></t:ProofOfDelivery>" if pod else ""
        resp = (f"<t:TrackShipmentResponse {NS}>{status()}<t:TrackingNumber>{trk}</t:TrackingNumber><t:Carrier>{carrier}</t:Carrier>"
                f"<t:CurrentStatus>{cur}</t:CurrentStatus>" + (f"<t:EstimatedDelivery>{eta}</t:EstimatedDelivery>" if eta else "") + f"{ev}{pod_xml}</t:TrackShipmentResponse>")
        call(calls, "TrackShipment", req_body, resp, start=at(90 + i * 41), ms=210 + i * 35, channel=["MOBILE_APP", "WEB", "MOBILE_APP"][i])
    call(calls, "TrackShipment",
         f"<t:TrackShipmentRequest {NS}><t:TrackingNumber>XX0000000000</t:TrackingNumber></t:TrackShipmentRequest>",
         fault("ValidationFault", "TRK-404", "Unknown tracking number"), start=at(140), ms=95, channel="IVR")

    # CancelShipment
    call(calls, "CancelShipment", f"<t:CancelShipmentRequest {NS}><t:ShipmentId>SHP-{880447 + day * 500}</t:ShipmentId></t:CancelShipmentRequest>",
         f"<t:CancelShipmentResponse {NS}>{status()}</t:CancelShipmentResponse>", start=at(155), ms=320, channel="STORE")
    call(calls, "CancelShipment", f"<t:CancelShipmentRequest {NS}><t:ShipmentId>SHP-{880410 + day * 500}</t:ShipmentId></t:CancelShipmentRequest>",
         fault("ValidationFault", "SHP-409", "Shipment already collected by carrier; it cannot be cancelled"), start=at(162), ms=140, channel="WEB")

    # day 2 runs slower; timeouts stay at the gateway limit
    return [(op, rq, rs, st, ms if ms >= 30000 else jitter(ms), ch, er) for op, rq, rs, st, ms, ch, er in calls]


os.makedirs(OUT_DIR, exist_ok=True)
for day in range(1, DAYS + 1):
    calls = calls_for(day)
    out = os.path.join(OUT_DIR, f"Shipping Logs - Day {day}.csv")
    with open(out, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(HEADER)
        for n, (op, req, res, start, ms, channel, error) in enumerate(calls):
            end = start + timedelta(milliseconds=ms)
            ts = lambda t: t.isoformat(timespec="milliseconds")
            err_type, err_msg, err_no = error or ("", "", "")
            call_id = str(uuid.UUID(int=(0x5A3E + day) << 96 | n))
            w.writerow([call_id, f"user-{1000 + n % 4}", f"demo.user{n % 4}", "", channel, f"10.0.{day}.{10 + n}", call_id,
                        req, "", "", ts(start), res, "", "", ts(end), "ShippingService", op, f"soa-node-0{1 + (n + day) % 3}.acme.local", "",
                        err_type, err_msg, "RETAIL", "EN", "N", f"sess-{day}{n:03d}", err_no, "SOA", "", "acme-storefront"])
    print(f"wrote {len(calls)} calls to {out}")
