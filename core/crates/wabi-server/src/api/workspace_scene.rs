//! Bounded native slide object schema and explicit audience projection.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use super::{bad, image_allowed, valid_id, Result};
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub(super) struct Design { pub theme:String, pub objects:Vec<Object> }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub(super) struct Object {
    pub id:String, pub kind:String, pub x:f64, pub y:f64, pub w:f64, pub h:f64, pub z:f64,
    pub text:String, pub image:Option<String>, pub fill:String, pub color:String, pub font_size:f64,
    pub align:String, pub fit:String, pub crop_x:f64, pub crop_y:f64,
}
fn color(value:&str)->bool { value.len()==7 && value.starts_with('#') && value[1..].bytes().all(|c|c.is_ascii_hexdigit()) }
fn range(value:f64,min:f64,max:f64)->bool { value.is_finite() && value>=min && value<=max }
fn validate(object:&Object)->Result<()> {
    valid_id(&object.id)?;
    if !["text","image","rect","ellipse","line","table","chart"].contains(&object.kind.as_str()) || !range(object.x,0.0,1.0) || !range(object.y,0.0,1.0) || !range(object.w,0.02,1.0) || !range(object.h,0.02,1.0) || object.x+object.w>1.000001 || object.y+object.h>1.000001 || !range(object.z,-1_000_000.0,1_000_000.0) { return Err(bad("Invalid native slide object bounds or type")); }
    if object.text.chars().count()>6000 || !color(&object.color) || !(object.fill=="transparent"||color(&object.fill)) || !range(object.font_size,12.0,72.0) || !["left","center","right"].contains(&object.align.as_str()) || !["contain","cover"].contains(&object.fit.as_str()) || !range(object.crop_x,0.0,1.0) || !range(object.crop_y,0.0,1.0) { return Err(bad("Unsupported native slide object style")); }
    if object.image.as_ref().is_some_and(|image|!image_allowed(image)) { return Err(bad("Unsupported native slide object image")); }
    Ok(())
}
pub(super) fn project(source:&Value)->Result<Design> {
    let root=source.as_object().ok_or_else(||bad("Invalid native slide design"))?;
    if root.keys().any(|key|!["theme","objects"].contains(&key.as_str())) { return Err(bad("Private metadata cannot enter a slide design")); }
    let theme=root.get("theme").and_then(Value::as_str).unwrap_or("");
    if !["paper","night","ocean"].contains(&theme) { return Err(bad("Unsupported native slide theme")); }
    let source_objects=root.get("objects").and_then(Value::as_object).ok_or_else(||bad("Native objects must have stable identities"))?;
    if source_objects.len()>64 { return Err(bad("Native slide object limit exceeded")); }
    let mut objects=Vec::new();
    for(id,value)in source_objects {
        valid_id(id)?;
        let mut value=value.as_object().ok_or_else(||bad("Invalid native slide object"))?.clone();
        let removed=match value.remove("removed") { None=>false,Some(Value::Bool(value))=>value,_=>return Err(bad("Invalid native object visibility")) };
        if value.contains_key("id") { return Err(bad("Native object identity cannot be replaced")); }
        value.insert("id".into(),json!(id));
        let object:Object=serde_json::from_value(Value::Object(value)).map_err(|_|bad("Unknown or private native object property"))?;
        validate(&object)?;
        if !removed { objects.push(object); }
    }
    objects.sort_by(|a,b|a.z.total_cmp(&b.z).then_with(||a.id.cmp(&b.id)));
    Ok(Design{theme:theme.into(),objects})
}
pub(super) fn audience(source:&Value)->Result<Design>{
    let design=project(source)?;
    if design.objects.iter().any(|object|object.kind=="image"&&object.image.is_some()&&object.fit=="cover") {return Err(bad("Finalize image crops before publishing an audience rendition"));}
    Ok(design)
}
#[cfg(test)]mod tests {
    use super::*;
    fn fixture()->Value { json!({"theme":"paper","objects":{"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa":{"kind":"text","x":0.1,"y":0.1,"w":0.8,"h":0.2,"z":0,"text":"Public","image":null,"fill":"transparent","color":"#242836","fontSize":24,"align":"left","fit":"contain","cropX":0.5,"cropY":0.5}}}) }
    #[test]fn workspace_scene_projection_excludes_removed_objects(){let mut source=fixture();source["objects"]["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]["removed"]=json!(true);source["objects"]["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]["text"]=json!("PRIVATE_REMOVED");assert!(project(&source).unwrap().objects.is_empty());}
    #[test]fn workspace_scene_rejects_notes_urls_and_outside_coordinates(){for(key,value)in[("notes",json!("SECRET")),("image",json!("https://private.invalid/image")),("x",json!(4)),("color",json!("url(secret)"))]{let mut source=fixture();source["objects"]["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"][key]=value;assert!(project(&source).is_err(),"{key}");}}
    #[test]fn workspace_scene_accepts_only_the_explicit_public_shape(){let result=project(&fixture()).unwrap();assert_eq!(result.objects.len(),1);assert_eq!(result.objects[0].text,"Public");assert!(!serde_json::to_string(&result).unwrap().contains("removed"));}
}
