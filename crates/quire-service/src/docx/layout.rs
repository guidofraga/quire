//! Reading order for the Word file: the page view's order, `(y, x)`, with regions that sit side
//! by side grouped into rows, so Word flows them as the page shows them instead of stacking
//! them in an order nobody wrote.
//!
//! Heights and widths come from the app, which measured them on the page; the CLI has no page,
//! so it estimates them from the content.

use std::collections::BTreeMap;

use quire_doc::{Document, Region};
use serde_json::Value as Json;

/// A region placed on the page.
#[derive(Clone, Copy)]
pub(super) struct Item<'a> {
    pub region: &'a Region,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// One step of the flow.
pub(super) enum Flow<'a> {
    /// A region on its own; `gap` px of space above it.
    Single { item: Item<'a>, gap: f64 },
    /// Regions side by side: columns starting at `cols` (px from the column's left), and rows
    /// of cells, each cell the regions in that column in reading order, with the gap above the row.
    Grid { cols: Vec<f64>, rows: Vec<(f64, Vec<Vec<Item<'a>>>)> },
}

/// Regions with absolute positions, areas expanded, in reading order; with whether each is
/// hidden by a collapsed area above it.
pub(super) fn placed(doc: &Document) -> Vec<(&Region, f64, f64, bool)> {
    fn walk<'a>(
        regions: &'a [Region],
        ox: f64,
        oy: f64,
        hidden: bool,
        out: &mut Vec<(&'a Region, f64, f64, bool)>,
    ) {
        for r in regions {
            let (x, y) = (ox + r.at[0], oy + r.at[1]);
            out.push((r, x, y, hidden));
            let collapsed = r.extra.get("collapsed").and_then(Json::as_bool).unwrap_or(false);
            walk(&r.regions, x, y, hidden || collapsed, out);
        }
    }
    let mut out = Vec::new();
    walk(&doc.regions, 0.0, 0.0, false, &mut out);
    out.sort_by(|a, b| a.2.total_cmp(&b.2).then(a.1.total_cmp(&b.1)));
    out
}

fn size_of(r: &Region) -> Option<[f64; 2]> {
    let s = r.extra.get("size")?.as_array()?;
    Some([s.first()?.as_f64()?, s.get(1)?.as_f64()?])
}

fn text_of(r: &Region, lang: Option<&str>) -> String {
    r.extra.get("text").and_then(|t| crate::localized(t, lang)).unwrap_or_default().to_string()
}

fn rows_of(r: &Region) -> usize {
    r.extra.get("rows").and_then(Json::as_array).map_or(0, Vec::len)
}

/// A region's size on the page in px: measured by the app when it gave one, else estimated.
pub(super) fn size(
    r: &Region,
    x: f64,
    content_w: f64,
    heights: &BTreeMap<String, f64>,
    widths: &BTreeMap<String, f64>,
    lang: Option<&str>,
) -> (f64, f64) {
    let room = (content_w - x).max(60.0);
    let caption = if r.extra.get("caption").is_some() { 22.0 } else { 0.0 };
    let (w, h) = match r.kind.as_str() {
        "math" => {
            let expr = r.expr.as_deref().unwrap_or_default();
            let note = r.extra.get("note").and_then(Json::as_str).map_or(0, str::len);
            let result = if r.show.is_some() { 14 } else { 0 };
            let w = (expr.chars().count() + result) as f64 * 7.5 + note as f64 * 6.0 + 16.0;
            let tall = if expr.contains('/') || expr.contains("sqrt") { 36.0 } else { 24.0 };
            let rows = expr.matches(';').count() as f64;
            (w.min(room), tall + rows * 16.0)
        }
        "text" => {
            let text = text_of(r, lang);
            let size =
                r.extra.get("style").and_then(|s| s.get("size")).and_then(Json::as_f64).unwrap_or(10.0);
            let line = size * 96.0 / 72.0 * 1.25;
            let chars_per_line = (room / (size * 0.55)).max(10.0);
            let fixed = r.extra.get("width").and_then(Json::as_f64);
            let longest = text.lines().map(|l| l.chars().count()).max().unwrap_or(1) as f64;
            let lines: f64 = text
                .lines()
                .filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with('{'))
                .map(|l| (l.chars().count() as f64 / chars_per_line).ceil().max(1.0))
                .sum();
            let w = fixed.unwrap_or_else(|| (longest * size * 0.55).min(room));
            (w, lines.max(1.0) * line + 4.0)
        }
        "image" | "plot2d" | "plot3d" => {
            let default = if r.kind == "plot3d" { [420.0, 340.0] } else { [480.0, 260.0] };
            let [w, h] = size_of(r).unwrap_or(if r.kind == "image" { [200.0, 150.0] } else { default });
            (w, h + caption)
        }
        "table" => {
            let cols = r.extra.get("columns").and_then(Json::as_array).map(|c| {
                c.iter().map(|c| c.get("width").and_then(Json::as_f64).unwrap_or(90.0)).sum::<f64>()
            });
            let w = cols.or_else(|| size_of(r).map(|s| s[0])).unwrap_or(300.0);
            let rows = rows_of(r).max(size_of(r).map_or(3, |s| (s[1] / 24.0) as usize));
            (w.min(room), rows as f64 * 24.0 + 4.0 + caption)
        }
        "solve" => {
            let lines = ["guesses", "given"]
                .iter()
                .map(|k| r.extra.get(*k).and_then(Json::as_array).map_or(0, Vec::len))
                .sum::<usize>()
                + 2;
            (320.0_f64.min(room), lines as f64 * 26.0 + 20.0)
        }
        "toc" => (room.min(640.0), 200.0),
        "area" => (content_w, 17.0),
        _ => (room.min(200.0), 18.0),
    };
    (widths.get(&r.id).copied().unwrap_or(w), heights.get(&r.id).copied().unwrap_or(h))
}

/// The page's flow: bands of regions that overlap vertically become rows of a grid when they
/// stand in more than one column. Consecutive rows with the same columns share one grid, so a
/// block of `a := 1   b := 2` lines is one table, as it reads on the page.
pub(super) fn flow(items: Vec<Item<'_>>) -> Vec<Flow<'_>> {
    // bands: regions that overlap in height
    let mut bands: Vec<(f64, f64, Vec<Item>)> = Vec::new();
    for it in items {
        let solo = matches!(it.region.kind.as_str(), "area" | "pagebreak");
        match bands.last_mut() {
            Some((_, bottom, list))
                if !solo
                    && it.y < *bottom - 2.0
                    && !list.iter().any(|i| i.region.kind == "area" || i.region.kind == "pagebreak") =>
            {
                *bottom = bottom.max(it.y + it.h);
                list.push(it);
            }
            _ => bands.push((it.y, it.y + it.h, vec![it])),
        }
    }
    let mut out: Vec<Flow> = Vec::new();
    let mut prev_bottom: Option<f64> = None;
    for (top, bottom, list) in bands {
        let gap = prev_bottom.map_or(0.0, |b| (top - b).max(0.0));
        prev_bottom = Some(prev_bottom.map_or(bottom, |b| b.max(bottom)));
        let cols = columns(&list);
        if cols.len() <= 1 {
            let mut last: Option<f64> = None;
            for it in list {
                let gap = last.map_or(gap, |b| (it.y - b).max(0.0));
                last = Some(last.map_or(it.y + it.h, |b| b.max(it.y + it.h)));
                out.push(Flow::Single { item: it, gap });
            }
            continue;
        }
        let xs: Vec<f64> = cols.iter().map(|c| c.0).collect();
        let cells: Vec<Vec<Item>> = cols.into_iter().map(|c| c.1).collect();
        if let Some(Flow::Grid { cols, rows }) = out.last_mut()
            && cols.len() == xs.len()
            && cols.iter().zip(&xs).all(|(a, b)| (a - b).abs() < 8.0)
        {
            rows.push((gap, cells));
            continue;
        }
        out.push(Flow::Grid { cols: xs, rows: vec![(gap, cells)] });
    }
    out
}

/// A band's columns: regions sorted by x, a new column wherever one starts right of everything
/// before it.
fn columns<'a>(list: &[Item<'a>]) -> Vec<(f64, Vec<Item<'a>>)> {
    let mut sorted: Vec<Item> = list.to_vec();
    sorted.sort_by(|a, b| a.x.total_cmp(&b.x));
    let mut cols: Vec<(f64, f64, Vec<Item>)> = Vec::new();
    for it in sorted {
        match cols.last_mut() {
            Some((_, right, items)) if it.x < *right - 4.0 => {
                *right = right.max(it.x + it.w);
                items.push(it);
            }
            _ => cols.push((it.x, it.x + it.w, vec![it])),
        }
    }
    cols.into_iter()
        .map(|(x, _, mut items)| {
            items.sort_by(|a, b| a.y.total_cmp(&b.y).then(a.x.total_cmp(&b.x)));
            (x, items)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(regions: Json) -> Option<Document> {
        Document::from_json(serde_json::json!({ "format": "quire/1", "regions": regions })).ok()
    }

    fn shape(flow: &[Flow]) -> Vec<String> {
        flow.iter()
            .map(|f| match f {
                Flow::Single { item, .. } => item.region.id.clone(),
                Flow::Grid { rows, .. } => format!(
                    "grid[{}]",
                    rows.iter()
                        .map(|(_, cells)| cells
                            .iter()
                            .map(|c| c.iter().map(|i| i.region.id.as_str()).collect::<Vec<_>>().join("+"))
                            .collect::<Vec<_>>()
                            .join("|"))
                        .collect::<Vec<_>>()
                        .join("/")
                ),
            })
            .collect()
    }

    fn items(d: &Document) -> Vec<Item<'_>> {
        placed(d)
            .into_iter()
            .filter(|p| !p.3)
            .map(|(r, x, y, _)| {
                let (w, h) = size(r, x, 680.0, &BTreeMap::new(), &BTreeMap::new(), None);
                Item { region: r, x, y, w, h }
            })
            .collect()
    }

    #[test]
    fn side_by_side_lines_become_one_grid_and_the_rest_flows_in_order() -> Result<(), String> {
        let d = doc(serde_json::json!([
            { "id": "t", "kind": "text", "at": [0, 0], "text": "# Data" },
            { "id": "a", "kind": "math", "at": [0, 40], "expr": "a := 1" },
            { "id": "b", "kind": "math", "at": [220, 40], "expr": "b := 2" },
            { "id": "c", "kind": "math", "at": [0, 75], "expr": "c := 3" },
            { "id": "d", "kind": "math", "at": [220, 75], "expr": "d := 4" },
            { "id": "e", "kind": "math", "at": [0, 120], "expr": "e := a + b", "show": "value" },
            { "id": "z", "kind": "area", "at": [0, 160], "collapsed": true, "regions": [
                { "id": "h", "kind": "math", "at": [0, 30], "expr": "h := 1" } ] }
        ]))
        .ok_or("document")?;
        assert_eq!(shape(&flow(items(&d))), ["t", "grid[a|b/c|d]", "e", "z"]);
        Ok(())
    }

    #[test]
    fn a_tall_figure_beside_lines_takes_its_own_column() -> Result<(), String> {
        let d = doc(serde_json::json!([
            { "id": "a", "kind": "math", "at": [0, 0], "expr": "a := 1" },
            { "id": "p", "kind": "image", "at": [300, 0], "size": [200, 150], "src": "assets/0000000000000000.png" },
            { "id": "b", "kind": "math", "at": [0, 40], "expr": "b := 2" }
        ]))
        .ok_or("document")?;
        assert_eq!(shape(&flow(items(&d))), ["grid[a+b|p]"]);
        Ok(())
    }
}
