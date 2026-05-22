// Prevents additional console window on macOS in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ros_dev_center_lib::run();
}
