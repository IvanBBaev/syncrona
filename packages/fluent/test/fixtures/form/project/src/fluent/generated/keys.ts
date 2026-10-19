import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    bom_json: {
                        table: 'sys_module'
                        id: '1cc0d5d67a9c47fa9bd0a21b23b59ffc'
                    }
                    'note-1': {
                        table: 'sys_ui_annotation'
                        id: '7f063b25438f4c79b45aa1988d0eb26c'
                    }
                    'note-2': {
                        table: 'sys_ui_annotation'
                        id: '3c20e947a5fd4e4cb6355f796b68027a'
                    }
                    'note-3': {
                        table: 'sys_ui_annotation'
                        id: '0b8b8e7fe7f548c4b3bd611d9268c8e2'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: 'c7b83c7ea513443b8c16f69cca00b83a'
                    }
                    rel: {
                        table: 'sys_relationship'
                        id: '8187a844639441188c068499555beb89'
                    }
                }
                composite: [
                    {
                        table: 'sys_ui_element'
                        id: '030bd4f4989d40a4a411beabce9d5a76'
                        key: {
                            sys_ui_section: {
                                id: '1dc4291a8ac6434c8840e7dbdae43196'
                                key: {
                                    name: 'x_snc_bprobe_task'
                                    caption: 'Activity & lists'
                                    view: {
                                        id: '672ee96223d6408bb98d39d3c1c7b2f3'
                                        key: {
                                            name: 'x_snc_bprobe_ops'
                                        }
                                    }
                                    sys_domain: 'global'
                                }
                            }
                            element: 'activity.xml'
                            position: '0'
                        }
                    },
                    {
                        table: 'sys_ui_element'
                        id: '0652883d642f42d2a0d4a21767235e23'
                        key: {
                            sys_ui_section: {
                                id: '8ad436973d164e6c9e64e2972dc3e6e2'
                                key: {
                                    name: 'x_snc_bprobe_task'
                                    caption: 'Overview'
                                    view: {
                                        id: '672ee96223d6408bb98d39d3c1c7b2f3'
                                        key: {
                                            name: 'x_snc_bprobe_ops'
                                        }
                                    }
                                    sys_domain: 'global'
                                }
                            }
                            element: 'name'
                            position: '1'
                        }
                    },
                    {
                        table: 'sys_ui_section'
                        id: '087fb62848f045c09af37c2011ec4f6b'
                        key: {
                            name: 'incident'
                            caption: 'Details'
                            view: {
                                id: 'Default view'
                                key: {
                                    name: 'NULL'
                                }
                            }
                            sys_domain: 'global'
                        }
                    },
                    {
                        table: 'sys_ui_element'
                        id: '105b61384b514a5f8d945c22f5bbfa48'
                        key: {
                            sys_ui_section: {
                                id: '1dc4291a8ac6434c8840e7dbdae43196'
                                key: {
                                    name: 'x_snc_bprobe_task'
                                    caption: 'Activity & lists'
                                    view: {
                                        id: '672ee96223d6408bb98d39d3c1c7b2f3'
                                        key: {
                                            name: 'x_snc_bprobe_ops'
                                        }
                                    }
                                    sys_domain: 'global'
                                }
                            }
                            element: 'custom.xml'
                            position: '2'
                        }
                    },
                    {
                        table: 'sys_ui_element'
                        id: '12723a9dec49417fa405332596e78198'
                        key: {
                            sys_ui_section: {
                                id: '8ad436973d164e6c9e64e2972dc3e6e2'
                                key: {
                                    name: 'x_snc_bprobe_task'
                                    caption: 'Overview'
                                    view: {
                                        id: '672ee96223d6408bb98d39d3c1c7b2f3'
                                        key: {
                                            name: 'x_snc_bprobe_ops'
                                        }
                                    }
                                    sys_domain: 'global'
                                }
                            }
                            element: '.split'
                            position: '3'
                        }
                    },
                    {
                        table: 'sys_ui_element'
                        id: '171ba8bb13794f39940f0e6e739d3071'
                        key: {
                            sys_ui_section: {
                                id: '8ad436973d164e6c9e64e2972dc3e6e2'
                                key: {
                                    name: 'x_snc_bprobe_task'
                                    caption: 'Overview'
                                    view: {
                                        id: '672ee96223d6408bb98d39d3c1c7b2f3'
                                        key: {
                                            name: 'x_snc_bprobe_ops'
                                        }
                                    }
                                    sys_domain: 'global'
                                }
                            }
                            element: 'description'
                            position: '9'
                        }
                    },
                    {
                        table: 'sys_ui_section'
                        id: '1dc4291a8ac6434c8840e7dbdae43196'
                        key: {
                            name: 'x_snc_bprobe_task'
                            caption: 'Activity & lists'
                            view: {
                                id: '672ee96223d6408bb98d39d3c1c7b2f3'
                                key: {
                                    name: 'x_snc_bprobe_ops'
                                }
                            }
                            sys_domain: 'global'
                        }
                    },
                    {
                        table: 'sys_ui_form'
                        id: '383c61334a5a468cb42eb10e80d0fded'
                        key: {
                            name: 'incident'
                            view: {
                                id: 'Default view'
                                key: {
                                    name: 'NULL'
                                }
                            }
                            sys_domain: 'global'
                        }
                    },
                    {
                        table: 'sys_ui_element'
                        id: '51a3bc8f9bda4ff3a9b164478b594101'
                        key: {
                            sys_ui_section: {
                                id: '8ad436973d164e6c9e64e2972dc3e6e2'
                                key: {
                                    name: 'x_snc_bprobe_task'
                                    caption: 'Overview'
                                    view: {
                                        id: '672ee96223d6408bb98d39d3c1c7b2f3'
                                        key: {
                                            name: 'x_snc_bprobe_ops'
                                        }
                                    }
                                    sys_domain: 'global'
                                }
                            }
                            element: '0b8b8e7fe7f548c4b3bd611d9268c8e2'
                            position: '8'
                        }
                    },
                    {
                        table: 'sys_ui_form_section'
                        id: '614180e00ed24c3bbc12e4e2f5182927'
                        key: {
                            sys_ui_form: {
                                id: '383c61334a5a468cb42eb10e80d0fded'
                                key: {
                                    name: 'incident'
                                    view: {
                                        id: 'Default view'
                                        key: {
                                            name: 'NULL'
                                        }
                                    }
                                    sys_domain: 'global'
                                }
                            }
                            sys_ui_section: {
                                id: '087fb62848f045c09af37c2011ec4f6b'
                                key: {
                                    name: 'incident'
                                    caption: 'Details'
                                    view: {
                                        id: 'Default view'
                                        key: {
                                            name: 'NULL'
                                        }
                                    }
                                    sys_domain: 'global'
                                }
                            }
                        }
                    },
                    {
                        table: 'sys_ui_element'
                        id: '6247a5719057469fb772f7c7faf2882f'
                        key: {
                            sys_ui_section: {
                                id: '1dc4291a8ac6434c8840e7dbdae43196'
                                key: {
                                    name: 'x_snc_bprobe_task'
                                    caption: 'Activity & lists'
                                    view: {
                                        id: '672ee96223d6408bb98d39d3c1c7b2f3'
                                        key: {
                                            name: 'x_snc_bprobe_ops'
                                        }
                                    }
                                    sys_domain: 'global'
                                }
                            }
                            element: 'REL.x_snc_bprobe_task.REL:8187a844639441188c068499555beb89'
                            position: '5'
                        }
                    },
                    {
                        table: 'sys_ui_element'
                        id: '6257678816d846aea18384a10d409e2a'
                        key: {
                            sys_ui_section: {
                                id: '8ad436973d164e6c9e64e2972dc3e6e2'
                                key: {
                                    name: 'x_snc_bprobe_task'
                                    caption: 'Overview'
                                    view: {
                                        id: '672ee96223d6408bb98d39d3c1c7b2f3'
                                        key: {
                                            name: 'x_snc_bprobe_ops'
                                        }
                                    }
                                    sys_domain: 'global'
                                }
                            }
                            element: '.end_split'
                            position: '5'
                        }
                    },
                    {
                        table: 'sys_ui_element'
                        id: '6701a52599c845cfab730d8bf2750620'
                        key: {
                            sys_ui_section: {
                                id: '8ad436973d164e6c9e64e2972dc3e6e2'
                                key: {
                                    name: 'x_snc_bprobe_task'
                                    caption: 'Overview'
                                    view: {
                                        id: '672ee96223d6408bb98d39d3c1c7b2f3'
                                        key: {
                                            name: 'x_snc_bprobe_ops'
                                        }
                                    }
                                    sys_domain: 'global'
                                }
                            }
                            element: '7f063b25438f4c79b45aa1988d0eb26c'
                            position: '6'
                        }
                    },
                    {
                        table: 'sys_ui_view'
                        id: '672ee96223d6408bb98d39d3c1c7b2f3'
                        key: {
                            name: 'x_snc_bprobe_ops'
                        }
                    },
                    {
                        table: 'sys_ui_element'
                        id: '85766f9c33c140f3b29ab861cc0a92e4'
                        key: {
                            sys_ui_section: {
                                id: '8ad436973d164e6c9e64e2972dc3e6e2'
                                key: {
                                    name: 'x_snc_bprobe_task'
                                    caption: 'Overview'
                                    view: {
                                        id: '672ee96223d6408bb98d39d3c1c7b2f3'
                                        key: {
                                            name: 'x_snc_bprobe_ops'
                                        }
                                    }
                                    sys_domain: 'global'
                                }
                            }
                            element: '.begin_split'
                            position: '0'
                        }
                    },
                    {
                        table: 'sys_ui_element'
                        id: '869b2e3200be43bd933ae194d7348818'
                        key: {
                            sys_ui_section: {
                                id: '8ad436973d164e6c9e64e2972dc3e6e2'
                                key: {
                                    name: 'x_snc_bprobe_task'
                                    caption: 'Overview'
                                    view: {
                                        id: '672ee96223d6408bb98d39d3c1c7b2f3'
                                        key: {
                                            name: 'x_snc_bprobe_ops'
                                        }
                                    }
                                    sys_domain: 'global'
                                }
                            }
                            element: '3c20e947a5fd4e4cb6355f796b68027a'
                            position: '7'
                        }
                    },
                    {
                        table: 'sys_ui_element'
                        id: '877a4fcfcd2a43e6bbc0212d6b9a0dc0'
                        key: {
                            sys_ui_section: {
                                id: '1dc4291a8ac6434c8840e7dbdae43196'
                                key: {
                                    name: 'x_snc_bprobe_task'
                                    caption: 'Activity & lists'
                                    view: {
                                        id: '672ee96223d6408bb98d39d3c1c7b2f3'
                                        key: {
                                            name: 'x_snc_bprobe_ops'
                                        }
                                    }
                                    sys_domain: 'global'
                                }
                            }
                            element: 'REL.x_snc_bprobe_task.REL:fedcba9876543210fedcba9876543210'
                            position: '6'
                        }
                    },
                    {
                        table: 'sys_ui_section'
                        id: '8ad436973d164e6c9e64e2972dc3e6e2'
                        key: {
                            name: 'x_snc_bprobe_task'
                            caption: 'Overview'
                            view: {
                                id: '672ee96223d6408bb98d39d3c1c7b2f3'
                                key: {
                                    name: 'x_snc_bprobe_ops'
                                }
                            }
                            sys_domain: 'global'
                        }
                    },
                    {
                        table: 'sys_ui_element'
                        id: '8d3ef502fb6e4e3e8f6f9e1b2fbca701'
                        key: {
                            sys_ui_section: {
                                id: '1dc4291a8ac6434c8840e7dbdae43196'
                                key: {
                                    name: 'x_snc_bprobe_task'
                                    caption: 'Activity & lists'
                                    view: {
                                        id: '672ee96223d6408bb98d39d3c1c7b2f3'
                                        key: {
                                            name: 'x_snc_bprobe_ops'
                                        }
                                    }
                                    sys_domain: 'global'
                                }
                            }
                            element: 'attached_knowledge'
                            position: '1'
                        }
                    },
                    {
                        table: 'sys_ui_element'
                        id: '9b74789e98d641098239eda6ce53337f'
                        key: {
                            sys_ui_section: {
                                id: '087fb62848f045c09af37c2011ec4f6b'
                                key: {
                                    name: 'incident'
                                    caption: 'Details'
                                    view: {
                                        id: 'Default view'
                                        key: {
                                            name: 'NULL'
                                        }
                                    }
                                    sys_domain: 'global'
                                }
                            }
                            element: 'number'
                            position: '0'
                        }
                    },
                    {
                        table: 'sys_ui_element'
                        id: 'a43971167b84452b85e28fc71433789c'
                        key: {
                            sys_ui_section: {
                                id: '1dc4291a8ac6434c8840e7dbdae43196'
                                key: {
                                    name: 'x_snc_bprobe_task'
                                    caption: 'Activity & lists'
                                    view: {
                                        id: '672ee96223d6408bb98d39d3c1c7b2f3'
                                        key: {
                                            name: 'x_snc_bprobe_ops'
                                        }
                                    }
                                    sys_domain: 'global'
                                }
                            }
                            element: '12M.x_snc_bprobe_task.task_sla.task'
                            position: '3'
                        }
                    },
                    {
                        table: 'sys_ui_element'
                        id: 'b27c349871e9490d97bbd3c52a026c51'
                        key: {
                            sys_ui_section: {
                                id: '1dc4291a8ac6434c8840e7dbdae43196'
                                key: {
                                    name: 'x_snc_bprobe_task'
                                    caption: 'Activity & lists'
                                    view: {
                                        id: '672ee96223d6408bb98d39d3c1c7b2f3'
                                        key: {
                                            name: 'x_snc_bprobe_ops'
                                        }
                                    }
                                    sys_domain: 'global'
                                }
                            }
                            element: 'M2M.x_snc_bprobe_task.x_m2m.parent'
                            position: '4'
                        }
                    },
                    {
                        table: 'sys_ui_form_section'
                        id: 'bc91ea74164a4f7f87650c3a013dc167'
                        key: {
                            sys_ui_form: {
                                id: 'dde62569b1904442be2b7cbdcb62a14b'
                                key: {
                                    name: 'x_snc_bprobe_task'
                                    view: {
                                        id: '672ee96223d6408bb98d39d3c1c7b2f3'
                                        key: {
                                            name: 'x_snc_bprobe_ops'
                                        }
                                    }
                                    sys_domain: 'global'
                                }
                            }
                            sys_ui_section: {
                                id: '8ad436973d164e6c9e64e2972dc3e6e2'
                                key: {
                                    name: 'x_snc_bprobe_task'
                                    caption: 'Overview'
                                    view: {
                                        id: '672ee96223d6408bb98d39d3c1c7b2f3'
                                        key: {
                                            name: 'x_snc_bprobe_ops'
                                        }
                                    }
                                    sys_domain: 'global'
                                }
                            }
                        }
                    },
                    {
                        table: 'sys_ui_element'
                        id: 'c789d4710c4c4da7b27d04a971133f22'
                        key: {
                            sys_ui_section: {
                                id: '087fb62848f045c09af37c2011ec4f6b'
                                key: {
                                    name: 'incident'
                                    caption: 'Details'
                                    view: {
                                        id: 'Default view'
                                        key: {
                                            name: 'NULL'
                                        }
                                    }
                                    sys_domain: 'global'
                                }
                            }
                            element: 'short_description'
                            position: '1'
                        }
                    },
                    {
                        table: 'sys_ui_element'
                        id: 'ddc8ee18c9b54eafb072a38f5de3d259'
                        key: {
                            sys_ui_section: {
                                id: 'e429800e9458435c8787700d0a051b9b'
                                key: {
                                    name: 'x_snc_bprobe_task'
                                    caption: 'Only'
                                    view: {
                                        id: 'ae280de478774e77ae645ff4a81b2d25'
                                        key: {
                                            name: 'x_snc_bprobe_byname'
                                        }
                                    }
                                    sys_domain: 'global'
                                }
                            }
                            element: 'name'
                            position: '0'
                        }
                    },
                    {
                        table: 'sys_ui_form'
                        id: 'dde62569b1904442be2b7cbdcb62a14b'
                        key: {
                            name: 'x_snc_bprobe_task'
                            view: {
                                id: '672ee96223d6408bb98d39d3c1c7b2f3'
                                key: {
                                    name: 'x_snc_bprobe_ops'
                                }
                            }
                            sys_domain: 'global'
                        }
                    },
                    {
                        table: 'sys_ui_form_section'
                        id: 'e308692791cb4529a56a492b6234c77f'
                        key: {
                            sys_ui_form: {
                                id: 'e402cd48f5914912aa5f9ff16a29454d'
                                key: {
                                    name: 'x_snc_bprobe_task'
                                    view: {
                                        id: 'ae280de478774e77ae645ff4a81b2d25'
                                        key: {
                                            name: 'x_snc_bprobe_byname'
                                        }
                                    }
                                    sys_domain: 'global'
                                }
                            }
                            sys_ui_section: {
                                id: 'e429800e9458435c8787700d0a051b9b'
                                key: {
                                    name: 'x_snc_bprobe_task'
                                    caption: 'Only'
                                    view: {
                                        id: 'ae280de478774e77ae645ff4a81b2d25'
                                        key: {
                                            name: 'x_snc_bprobe_byname'
                                        }
                                    }
                                    sys_domain: 'global'
                                }
                            }
                        }
                    },
                    {
                        table: 'sys_ui_form_section'
                        id: 'e348d61c1a2a4a3aad1265ed6a92b966'
                        key: {
                            sys_ui_form: {
                                id: 'dde62569b1904442be2b7cbdcb62a14b'
                                key: {
                                    name: 'x_snc_bprobe_task'
                                    view: {
                                        id: '672ee96223d6408bb98d39d3c1c7b2f3'
                                        key: {
                                            name: 'x_snc_bprobe_ops'
                                        }
                                    }
                                    sys_domain: 'global'
                                }
                            }
                            sys_ui_section: {
                                id: '1dc4291a8ac6434c8840e7dbdae43196'
                                key: {
                                    name: 'x_snc_bprobe_task'
                                    caption: 'Activity & lists'
                                    view: {
                                        id: '672ee96223d6408bb98d39d3c1c7b2f3'
                                        key: {
                                            name: 'x_snc_bprobe_ops'
                                        }
                                    }
                                    sys_domain: 'global'
                                }
                            }
                        }
                    },
                    {
                        table: 'sys_ui_form'
                        id: 'e402cd48f5914912aa5f9ff16a29454d'
                        key: {
                            name: 'x_snc_bprobe_task'
                            view: {
                                id: 'ae280de478774e77ae645ff4a81b2d25'
                                key: {
                                    name: 'x_snc_bprobe_byname'
                                }
                            }
                            sys_domain: 'global'
                        }
                    },
                    {
                        table: 'sys_ui_section'
                        id: 'e429800e9458435c8787700d0a051b9b'
                        key: {
                            name: 'x_snc_bprobe_task'
                            caption: 'Only'
                            view: {
                                id: 'ae280de478774e77ae645ff4a81b2d25'
                                key: {
                                    name: 'x_snc_bprobe_byname'
                                }
                            }
                            sys_domain: 'global'
                        }
                    },
                    {
                        table: 'sys_ui_element'
                        id: 'f36cb8d764e64760b4a949ed7afeb3dc'
                        key: {
                            sys_ui_section: {
                                id: '8ad436973d164e6c9e64e2972dc3e6e2'
                                key: {
                                    name: 'x_snc_bprobe_task'
                                    caption: 'Overview'
                                    view: {
                                        id: '672ee96223d6408bb98d39d3c1c7b2f3'
                                        key: {
                                            name: 'x_snc_bprobe_ops'
                                        }
                                    }
                                    sys_domain: 'global'
                                }
                            }
                            element: 'priority'
                            position: '4'
                        }
                    },
                    {
                        table: 'sys_ui_element'
                        id: 'f44bc18376084c89976e6469fdc709c4'
                        key: {
                            sys_ui_section: {
                                id: '8ad436973d164e6c9e64e2972dc3e6e2'
                                key: {
                                    name: 'x_snc_bprobe_task'
                                    caption: 'Overview'
                                    view: {
                                        id: '672ee96223d6408bb98d39d3c1c7b2f3'
                                        key: {
                                            name: 'x_snc_bprobe_ops'
                                        }
                                    }
                                    sys_domain: 'global'
                                }
                            }
                            element: 'category'
                            position: '2'
                        }
                    },
                ]
            }
        }
    }
}
