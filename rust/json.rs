//! Minimal JSON reader/writer shared by the three reference plugins.
//! Standard library only: the plugin crates have no dependencies at all.
#![allow(dead_code)] // Each plugin uses a different subset of this helper.

#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(String),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(text) => Some(text),
            _ => None,
        }
    }

    pub fn string(text: &str) -> Json {
        Json::Str(text.to_owned())
    }

    pub fn number(raw: &str) -> Json {
        Json::Num(raw.to_owned())
    }

    pub fn object(fields: Vec<(&str, Json)>) -> Json {
        Json::Obj(
            fields
                .into_iter()
                .map(|(key, value)| (key.to_owned(), value))
                .collect(),
        )
    }

    pub fn encode(&self, out: &mut String) {
        match self {
            Json::Null => out.push_str("null"),
            Json::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
            Json::Num(raw) => out.push_str(raw),
            Json::Str(text) => encode_string(text, out),
            Json::Arr(items) => {
                out.push('[');
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    item.encode(out);
                }
                out.push(']');
            }
            Json::Obj(fields) => {
                out.push('{');
                for (index, (key, value)) in fields.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    encode_string(key, out);
                    out.push(':');
                    value.encode(out);
                }
                out.push('}');
            }
        }
    }

    pub fn to_text(&self) -> String {
        let mut text = String::new();
        self.encode(&mut text);
        text
    }
}

pub fn encode_string(text: &str, out: &mut String) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            control if (control as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", control as u32));
            }
            other => out.push(other),
        }
    }
    out.push('"');
}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn fail<T>(&self, message: &str) -> Result<T, String> {
        Err(format!("{message} at byte {}", self.pos))
    }

    fn skip_space(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\r' | b'\n')) {
            self.pos += 1;
        }
    }

    fn literal(&mut self, word: &[u8]) -> Result<(), String> {
        if self.bytes.get(self.pos..self.pos + word.len()) == Some(word) {
            self.pos += word.len();
            Ok(())
        } else {
            self.fail("bad literal")
        }
    }

    fn value(&mut self) -> Result<Json, String> {
        self.skip_space();
        match self.peek() {
            Some(b'n') => {
                self.literal(b"null")?;
                Ok(Json::Null)
            }
            Some(b't') => {
                self.literal(b"true")?;
                Ok(Json::Bool(true))
            }
            Some(b'f') => {
                self.literal(b"false")?;
                Ok(Json::Bool(false))
            }
            Some(b'"') => Ok(Json::Str(self.string()?)),
            Some(b'[') => self.array(),
            Some(b'{') => self.object(),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => self.fail("expected a JSON value"),
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.pos;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.pos += 1;
        }
        self.pos - start
    }

    fn number(&mut self) -> Result<Json, String> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        if self.digits() == 0 {
            return self.fail("expected a digit");
        }
        if self.peek() == Some(b'.') {
            self.pos += 1;
            if self.digits() == 0 {
                return self.fail("expected a fraction digit");
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            if self.digits() == 0 {
                return self.fail("expected an exponent digit");
            }
        }
        let raw = std::str::from_utf8(&self.bytes[start..self.pos]).map_err(|e| e.to_string())?;
        Ok(Json::Num(raw.to_owned()))
    }

    fn hex4(&mut self) -> Result<u32, String> {
        let mut value = 0u32;
        for _ in 0..4 {
            let digit = match self.peek() {
                Some(b'0'..=b'9') => (self.bytes[self.pos] - b'0') as u32,
                Some(b'a'..=b'f') => (self.bytes[self.pos] - b'a' + 10) as u32,
                Some(b'A'..=b'F') => (self.bytes[self.pos] - b'A' + 10) as u32,
                _ => return self.fail("bad unicode escape"),
            };
            value = value * 16 + digit;
            self.pos += 1;
        }
        Ok(value)
    }

    fn string(&mut self) -> Result<String, String> {
        self.pos += 1; // opening quote
        let mut buf: Vec<u8> = Vec::new();
        loop {
            let byte = match self.peek() {
                Some(byte) => byte,
                None => return self.fail("unterminated string"),
            };
            match byte {
                b'"' => {
                    self.pos += 1;
                    break;
                }
                b'\\' => {
                    self.pos += 1;
                    let escape = match self.peek() {
                        Some(escape) => escape,
                        None => return self.fail("bad escape"),
                    };
                    self.pos += 1;
                    match escape {
                        b'"' => buf.push(b'"'),
                        b'\\' => buf.push(b'\\'),
                        b'/' => buf.push(b'/'),
                        b'b' => buf.push(0x08),
                        b'f' => buf.push(0x0c),
                        b'n' => buf.push(b'\n'),
                        b'r' => buf.push(b'\r'),
                        b't' => buf.push(b'\t'),
                        b'u' => {
                            let high = self.hex4()?;
                            let code = if (0xd800..=0xdbff).contains(&high) {
                                if self.bytes.get(self.pos..self.pos + 2) != Some(&b"\\u"[..]) {
                                    return self.fail("missing low surrogate");
                                }
                                self.pos += 2;
                                let low = self.hex4()?;
                                if !(0xdc00..=0xdfff).contains(&low) {
                                    return self.fail("bad low surrogate");
                                }
                                0x10000 + ((high - 0xd800) << 10) + (low - 0xdc00)
                            } else {
                                high
                            };
                            let ch = char::from_u32(code).ok_or("invalid unicode escape")?;
                            let mut tmp = [0u8; 4];
                            buf.extend_from_slice(ch.encode_utf8(&mut tmp).as_bytes());
                        }
                        _ => return self.fail("bad escape"),
                    }
                }
                0..=0x1f => return self.fail("control character in string"),
                _ => {
                    buf.push(byte);
                    self.pos += 1;
                }
            }
        }
        String::from_utf8(buf).map_err(|e| e.to_string())
    }

    fn array(&mut self) -> Result<Json, String> {
        self.pos += 1; // '['
        let mut items = Vec::new();
        self.skip_space();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(Json::Arr(items));
        }
        loop {
            items.push(self.value()?);
            self.skip_space();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b']') => {
                    self.pos += 1;
                    break;
                }
                _ => return self.fail("expected ',' or ']'"),
            }
        }
        Ok(Json::Arr(items))
    }

    fn object(&mut self) -> Result<Json, String> {
        self.pos += 1; // '{'
        let mut fields = Vec::new();
        self.skip_space();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(Json::Obj(fields));
        }
        loop {
            self.skip_space();
            if self.peek() != Some(b'"') {
                return self.fail("expected an object key");
            }
            let key = self.string()?;
            self.skip_space();
            if self.peek() != Some(b':') {
                return self.fail("expected ':'");
            }
            self.pos += 1;
            let value = self.value()?;
            fields.push((key, value));
            self.skip_space();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b'}') => {
                    self.pos += 1;
                    break;
                }
                _ => return self.fail("expected ',' or '}'"),
            }
        }
        Ok(Json::Obj(fields))
    }
}

pub fn parse(text: &str) -> Result<Json, String> {
    let mut parser = Parser {
        bytes: text.as_bytes(),
        pos: 0,
    };
    let value = parser.value()?;
    parser.skip_space();
    if parser.pos != parser.bytes.len() {
        return parser.fail("trailing data");
    }
    Ok(value)
}

/// A malformed line may still carry a usable id; echo it so the host can match the error.
pub fn salvage_id(line: &str) -> Json {
    let bytes = line.as_bytes();
    let mut offset = 0usize;
    while let Some(at) = line[offset..].find("\"id\"") {
        let mut pos = offset + at + 4;
        while matches!(bytes.get(pos), Some(b' ' | b'\t' | b'\r' | b'\n')) {
            pos += 1;
        }
        if bytes.get(pos) == Some(&b':') {
            pos += 1;
            while matches!(bytes.get(pos), Some(b' ' | b'\t' | b'\r' | b'\n')) {
                pos += 1;
            }
            let start = pos;
            if bytes.get(pos) == Some(&b'-') {
                pos += 1;
            }
            while bytes.get(pos).is_some_and(u8::is_ascii_digit) {
                pos += 1;
            }
            if let Ok(Json::Num(raw)) = parse(&line[start..pos]) {
                return Json::Num(raw);
            }
        }
        offset = pos.max(offset + at + 4);
    }
    Json::Null
}

pub fn ok(id: Json, result: Json) -> Json {
    Json::object(vec![
        ("id", id),
        ("ok", Json::Bool(true)),
        ("result", result),
    ])
}

pub fn error(id: Json, message: &str) -> Json {
    Json::object(vec![
        ("id", id),
        ("ok", Json::Bool(false)),
        ("error", Json::string(message)),
    ])
}

pub fn hello(name: &str, version: &str, capabilities: &[&str]) -> Json {
    Json::object(vec![
        ("name", Json::string(name)),
        ("version", Json::string(version)),
        (
            "capabilities",
            Json::Arr(capabilities.iter().map(|cap| Json::string(*cap)).collect()),
        ),
    ])
}
